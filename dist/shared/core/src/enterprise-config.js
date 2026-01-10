"use strict";
// Enterprise Configuration Management System
// Production-ready configuration with validation, hot reloading, and multi-environment support
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG_SCHEMA = exports.EnterpriseConfigurationManager = void 0;
exports.getEnterpriseConfigManager = getEnterpriseConfigManager;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger = (0, logger_1.createLogger)('enterprise-config');
class EnterpriseConfigurationManager {
    constructor(schema) {
        this.redis = (0, redis_1.getRedisClient)();
        this.layers = [];
        this.schema = {};
        this.config = {};
        this.changeHistory = [];
        this.watchers = new Map();
        this.validationCache = new Map();
        this.hotReloadEnabled = true;
        this.configFileWatchers = [];
        if (schema) {
            this.schema = schema;
        }
        this.initializeDefaultLayers();
    }
    // Load configuration from all layers
    async loadConfiguration() {
        logger.info('Loading enterprise configuration');
        // Load from all sources
        await this.loadEnvironmentVariables();
        await this.loadConfigurationFiles();
        await this.loadRedisConfiguration();
        await this.loadRuntimeConfiguration();
        // Merge layers by priority
        this.mergeConfigurationLayers();
        // Validate configuration
        const validation = this.validateConfiguration();
        if (!validation.valid) {
            logger.error('Configuration validation failed', {
                errors: validation.errors.length,
                warnings: validation.warnings.length
            });
            // Log critical errors
            for (const error of validation.errors) {
                logger.error(`Config validation error: ${error.path}`, {
                    message: error.message,
                    value: error.value
                });
            }
        }
        // Cache validation result
        this.validationCache.set('current', validation);
        // Setup file watchers for hot reloading
        if (this.hotReloadEnabled) {
            this.setupFileWatchers();
        }
        return validation;
    }
    // Get configuration value with path support
    get(path, defaultValue) {
        const keys = path.split('.');
        let value = this.config;
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            }
            else {
                return defaultValue;
            }
        }
        return value;
    }
    // Set configuration value at runtime
    async set(path, value, source = 'runtime', user) {
        const oldValue = this.get(path);
        // Validate the change
        const validation = this.validatePath(path, value);
        if (!validation.valid) {
            logger.warn('Configuration change validation failed', {
                path,
                value,
                errors: validation.errors
            });
            return validation;
        }
        // Apply the change
        this.setPathValue(path, value);
        // Record the change
        const change = {
            path,
            oldValue,
            newValue: value,
            source,
            timestamp: Date.now(),
            user
        };
        this.changeHistory.push(change);
        // Keep only recent history
        if (this.changeHistory.length > 1000) {
            this.changeHistory = this.changeHistory.slice(-1000);
        }
        // Persist to Redis if runtime change
        if (source === 'runtime') {
            await this.persistRuntimeChange(path, value);
        }
        // Notify watchers
        await this.notifyWatchers(path, value);
        logger.info('Configuration updated', {
            path,
            oldValue,
            newValue: value,
            source,
            user: user || 'system'
        });
        return validation;
    }
    // Watch configuration changes
    watch(path, callback) {
        if (!this.watchers.has(path)) {
            this.watchers.set(path, []);
        }
        this.watchers.get(path).push(callback);
    }
    // Unwatch configuration changes
    unwatch(path, callback) {
        if (!this.watchers.has(path))
            return;
        if (callback) {
            const callbacks = this.watchers.get(path);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
        else {
            this.watchers.delete(path);
        }
    }
    // Hot reload configuration
    async hotReload() {
        logger.info('Performing hot reload of configuration');
        // Reload from sources
        await this.loadConfigurationFiles();
        await this.loadRedisConfiguration();
        // Merge and validate
        this.mergeConfigurationLayers();
        const validation = this.validateConfiguration();
        if (validation.valid) {
            // Notify all watchers of full config change
            await this.notifyWatchers('', this.config);
            logger.info('Hot reload completed successfully');
        }
        else {
            logger.error('Hot reload failed validation', {
                errors: validation.errors.length
            });
        }
        return validation;
    }
    // Get configuration schema
    getSchema() {
        return { ...this.schema };
    }
    // Update configuration schema
    updateSchema(newSchema) {
        this.schema = { ...newSchema };
        // Re-validate current configuration
        const validation = this.validateConfiguration();
        this.validationCache.set('current', validation);
        logger.info('Configuration schema updated', {
            fields: Object.keys(newSchema).length
        });
    }
    // Get configuration change history
    getChangeHistory(limit = 100) {
        return this.changeHistory.slice(-limit);
    }
    // Export configuration for backup
    exportConfiguration() {
        return {
            schema: this.schema,
            layers: this.layers.map(layer => ({
                ...layer,
                data: { ...layer.data } // Deep copy
            })),
            config: { ...this.config },
            changeHistory: [...this.changeHistory],
            timestamp: Date.now()
        };
    }
    // Import configuration from backup
    async importConfiguration(backup) {
        try {
            this.schema = backup.schema;
            this.layers = backup.layers;
            this.changeHistory = backup.changeHistory || [];
            // Merge and validate
            this.mergeConfigurationLayers();
            const validation = this.validateConfiguration();
            if (validation.valid) {
                logger.info('Configuration imported successfully');
            }
            else {
                logger.error('Configuration import failed validation');
            }
            return validation;
        }
        catch (error) {
            logger.error('Failed to import configuration', { error });
            return {
                valid: false,
                errors: [{
                        path: 'import',
                        message: `Import failed: ${error.message}`,
                        value: null
                    }],
                warnings: []
            };
        }
    }
    // Get configuration statistics
    getStats() {
        return {
            layers: this.layers.length,
            schemaFields: Object.keys(this.schema).length,
            totalChanges: this.changeHistory.length,
            watchers: Array.from(this.watchers.entries()).reduce((sum, [, callbacks]) => sum + callbacks.length, 0),
            validationCacheSize: this.validationCache.size,
            fileWatchers: this.configFileWatchers.length,
            hotReloadEnabled: this.hotReloadEnabled
        };
    }
    // Cleanup resources
    cleanup() {
        // Stop file watchers
        for (const watcher of this.configFileWatchers) {
            watcher.close();
        }
        this.configFileWatchers = [];
        // Clear caches
        this.validationCache.clear();
        this.watchers.clear();
        logger.info('Configuration manager cleaned up');
    }
    // Private methods
    initializeDefaultLayers() {
        // Default layers in priority order (higher number = higher priority)
        this.layers = [
            {
                name: 'default',
                priority: 0,
                source: 'runtime',
                data: {}
            },
            {
                name: 'file',
                priority: 10,
                source: 'file',
                data: {}
            },
            {
                name: 'environment',
                priority: 20,
                source: 'environment',
                data: {}
            },
            {
                name: 'redis',
                priority: 30,
                source: 'redis',
                data: {}
            },
            {
                name: 'runtime',
                priority: 40,
                source: 'runtime',
                data: {}
            }
        ];
    }
    async loadEnvironmentVariables() {
        const envLayer = this.layers.find(l => l.source === 'environment');
        envLayer.data = {};
        // Load environment variables with CONFIG_ prefix
        for (const [key, value] of Object.entries(process.env)) {
            if (key.startsWith('CONFIG_')) {
                const configKey = key.substring(7).toLowerCase().replace(/_/g, '.');
                this.setNestedValue(envLayer.data, configKey, value);
            }
        }
        logger.debug('Loaded environment configuration', {
            variables: Object.keys(envLayer.data).length
        });
    }
    async loadConfigurationFiles() {
        const fileLayer = this.layers.find(l => l.source === 'file');
        const configFiles = [
            '/Users/pho/DEV/Arbitrage_Bot/Optimized_Arb_Bot_V3/config/default.json',
            '/Users/pho/DEV/Arbitrage_Bot/Optimized_Arb_Bot_V3/config/production.json',
            `/Users/pho/DEV/Arbitrage_Bot/Optimized_Arb_Bot_V3/config/${process.env.NODE_ENV || 'development'}.json`,
            '/Users/pho/DEV/Arbitrage_Bot/Optimized_Arb_Bot_V3/config/local.json'
        ];
        fileLayer.data = {};
        for (const configFile of configFiles) {
            try {
                if (fs.existsSync(configFile)) {
                    const content = fs.readFileSync(configFile, 'utf8');
                    const config = JSON.parse(content);
                    // Deep merge
                    this.deepMerge(fileLayer.data, config);
                    fileLayer.lastModified = fs.statSync(configFile).mtime.getTime();
                    logger.debug(`Loaded config file: ${path.basename(configFile)}`);
                }
            }
            catch (error) {
                logger.warn(`Failed to load config file: ${configFile}`, { error: error.message });
            }
        }
    }
    async loadRedisConfiguration() {
        const redisLayer = this.layers.find(l => l.source === 'redis');
        try {
            const redisConfig = await this.redis.get('config:runtime');
            if (redisConfig) {
                redisLayer.data = JSON.parse(redisConfig);
                logger.debug('Loaded Redis configuration');
            }
        }
        catch (error) {
            logger.warn('Failed to load Redis configuration', { error: error.message });
        }
    }
    async loadRuntimeConfiguration() {
        const runtimeLayer = this.layers.find(l => l.source === 'runtime');
        runtimeLayer.data = {};
        // Load any runtime overrides
        // This could be populated by API calls or other runtime sources
    }
    mergeConfigurationLayers() {
        // Sort layers by priority (highest first)
        const sortedLayers = [...this.layers].sort((a, b) => b.priority - a.priority);
        this.config = {};
        // Merge layers
        for (const layer of sortedLayers) {
            this.deepMerge(this.config, layer.data);
        }
    }
    validateConfiguration() {
        const result = {
            valid: true,
            errors: [],
            warnings: []
        };
        // Validate each schema field
        for (const [path, fieldSchema] of Object.entries(this.schema)) {
            const value = this.get(path);
            if (value === undefined) {
                if (fieldSchema.required) {
                    result.errors.push({
                        path,
                        message: `Required field is missing`,
                        value
                    });
                    result.valid = false;
                }
                else if (fieldSchema.default !== undefined) {
                    // Set default value
                    this.setPathValue(path, fieldSchema.default);
                }
                continue;
            }
            // Type validation
            if (!this.validateType(value, fieldSchema.type)) {
                result.errors.push({
                    path,
                    message: `Invalid type. Expected ${fieldSchema.type}, got ${typeof value}`,
                    value
                });
                result.valid = false;
                continue;
            }
            // Custom validation
            if (fieldSchema.validation) {
                const validationErrors = this.validateField(path, value, fieldSchema.validation);
                result.errors.push(...validationErrors);
                if (validationErrors.length > 0) {
                    result.valid = false;
                }
            }
        }
        return result;
    }
    validatePath(path, value) {
        const result = {
            valid: true,
            errors: [],
            warnings: []
        };
        const fieldSchema = this.schema[path];
        if (!fieldSchema) {
            result.warnings.push({
                path,
                message: 'Field not defined in schema',
                value
            });
            return result;
        }
        // Type validation
        if (!this.validateType(value, fieldSchema.type)) {
            result.errors.push({
                path,
                message: `Invalid type. Expected ${fieldSchema.type}, got ${typeof value}`,
                value
            });
            result.valid = false;
        }
        // Custom validation
        if (fieldSchema.validation && result.valid) {
            const validationErrors = this.validateField(path, value, fieldSchema.validation);
            result.errors.push(...validationErrors);
            if (validationErrors.length > 0) {
                result.valid = false;
            }
        }
        return result;
    }
    validateType(value, expectedType) {
        switch (expectedType) {
            case 'string': return typeof value === 'string';
            case 'number': return typeof value === 'number' && !isNaN(value);
            case 'boolean': return typeof value === 'boolean';
            case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
            case 'array': return Array.isArray(value);
            default: return false;
        }
    }
    validateField(path, value, validation) {
        const errors = [];
        if (validation.min !== undefined && value < validation.min) {
            errors.push({
                path,
                message: `Value ${value} is below minimum ${validation.min}`,
                value
            });
        }
        if (validation.max !== undefined && value > validation.max) {
            errors.push({
                path,
                message: `Value ${value} is above maximum ${validation.max}`,
                value
            });
        }
        if (validation.pattern && typeof value === 'string') {
            const regex = new RegExp(validation.pattern);
            if (!regex.test(value)) {
                errors.push({
                    path,
                    message: `Value does not match pattern ${validation.pattern}`,
                    value
                });
            }
        }
        if (validation.enum && !validation.enum.includes(value)) {
            errors.push({
                path,
                message: `Value must be one of: ${validation.enum.join(', ')}`,
                value
            });
        }
        if (validation.custom && typeof validation.custom === 'function') {
            if (!validation.custom(value)) {
                errors.push({
                    path,
                    message: 'Value failed custom validation',
                    value
                });
            }
        }
        return errors;
    }
    async setupFileWatchers() {
        const configDir = '/Users/pho/DEV/Arbitrage_Bot/Optimized_Arb_Bot_V3/config';
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        const configFiles = [
            'default.json',
            'production.json',
            'development.json',
            'local.json'
        ];
        for (const file of configFiles) {
            const filePath = path.join(configDir, file);
            if (fs.existsSync(filePath)) {
                const watcher = fs.watch(filePath, async (eventType) => {
                    if (eventType === 'change') {
                        logger.info(`Config file changed: ${file}`);
                        // Debounce hot reload
                        setTimeout(async () => {
                            try {
                                await this.hotReload();
                            }
                            catch (error) {
                                logger.error('Hot reload failed', { error });
                            }
                        }, 1000);
                    }
                });
                this.configFileWatchers.push(watcher);
            }
        }
    }
    async notifyWatchers(path, newValue) {
        // Notify specific path watchers
        if (this.watchers.has(path)) {
            const callbacks = this.watchers.get(path);
            for (const callback of callbacks) {
                try {
                    callback(newValue);
                }
                catch (error) {
                    logger.error('Watcher callback failed', { path, error });
                }
            }
        }
        // Notify wildcard watchers (empty path means full config)
        if (path === '' && this.watchers.has('*')) {
            const callbacks = this.watchers.get('*');
            for (const callback of callbacks) {
                try {
                    callback(this.config);
                }
                catch (error) {
                    logger.error('Wildcard watcher callback failed', { error });
                }
            }
        }
    }
    async persistRuntimeChange(path, value) {
        const runtimeLayer = this.layers.find(l => l.source === 'runtime');
        this.setNestedValue(runtimeLayer.data, path, value);
        // Persist to Redis
        await this.redis.set('config:runtime', JSON.stringify(runtimeLayer.data));
    }
    setPathValue(path, value) {
        const keys = path.split('.');
        let obj = this.config;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!obj[key] || typeof obj[key] !== 'object') {
                obj[key] = {};
            }
            obj = obj[key];
        }
        obj[keys[keys.length - 1]] = value;
    }
    setNestedValue(obj, path, value) {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;
    }
    deepMerge(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                if (!target[key] || typeof target[key] !== 'object') {
                    target[key] = {};
                }
                this.deepMerge(target[key], source[key]);
            }
            else {
                target[key] = source[key];
            }
        }
    }
}
exports.EnterpriseConfigurationManager = EnterpriseConfigurationManager;
// Global configuration manager instance
let globalConfigManager = null;
function getEnterpriseConfigManager(schema) {
    if (!globalConfigManager) {
        globalConfigManager = new EnterpriseConfigurationManager(schema);
    }
    return globalConfigManager;
}
// Default configuration schema for arbitrage system
exports.DEFAULT_CONFIG_SCHEMA = {
    'app.name': {
        type: 'string',
        required: true,
        default: 'Arbitrage Detection System',
        description: 'Application name'
    },
    'app.version': {
        type: 'string',
        required: true,
        default: '1.0.0',
        description: 'Application version'
    },
    'app.environment': {
        type: 'string',
        required: true,
        enum: ['development', 'staging', 'production'],
        default: 'development',
        description: 'Deployment environment'
    },
    'redis.url': {
        type: 'string',
        required: true,
        default: 'redis://localhost:6379',
        description: 'Redis connection URL'
    },
    'redis.password': {
        type: 'string',
        required: false,
        description: 'Redis password'
    },
    'services.coordinator.port': {
        type: 'number',
        required: true,
        default: 3000,
        validation: { min: 1000, max: 65535 },
        description: 'Coordinator service port'
    },
    'services.detectors.concurrency': {
        type: 'number',
        required: true,
        default: 10,
        validation: { min: 1, max: 100 },
        description: 'Maximum concurrent detector operations'
    },
    'arbitrage.minProfit': {
        type: 'number',
        required: true,
        default: 0.005,
        validation: { min: 0.001, max: 0.1 },
        description: 'Minimum profit threshold for arbitrage (0.5%)'
    },
    'arbitrage.maxSlippage': {
        type: 'number',
        required: true,
        default: 0.02,
        validation: { min: 0.001, max: 0.1 },
        description: 'Maximum allowed slippage (2%)'
    },
    'risk.maxDrawdown': {
        type: 'number',
        required: true,
        default: 0.1,
        validation: { min: 0.01, max: 0.5 },
        description: 'Maximum allowed drawdown (10%)'
    },
    'risk.maxDailyLoss': {
        type: 'number',
        required: true,
        default: 0.05,
        validation: { min: 0.01, max: 0.2 },
        description: 'Maximum daily loss (5%)'
    },
    'monitoring.enabled': {
        type: 'boolean',
        required: true,
        default: true,
        description: 'Enable monitoring and metrics'
    },
    'monitoring.interval': {
        type: 'number',
        required: true,
        default: 30000,
        validation: { min: 5000, max: 300000 },
        description: 'Monitoring interval in milliseconds'
    }
};
//# sourceMappingURL=enterprise-config.js.map