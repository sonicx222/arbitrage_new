export interface ConfigurationSchema {
    [key: string]: {
        type: 'string' | 'number' | 'boolean' | 'object' | 'array';
        required: boolean;
        default?: any;
        validation?: {
            min?: number;
            max?: number;
            pattern?: string;
            enum?: string[];
            custom?: (value: any) => boolean;
        };
        description?: string;
    };
}
export interface ConfigurationLayer {
    name: string;
    priority: number;
    source: 'file' | 'environment' | 'redis' | 'runtime';
    data: any;
    lastModified?: number;
}
export interface ValidationResult {
    valid: boolean;
    errors: Array<{
        path: string;
        message: string;
        value: any;
    }>;
    warnings: Array<{
        path: string;
        message: string;
        value: any;
    }>;
}
export interface ConfigurationChange {
    path: string;
    oldValue: any;
    newValue: any;
    source: string;
    timestamp: number;
    user?: string;
}
export declare class EnterpriseConfigurationManager {
    private redis;
    private layers;
    private schema;
    private config;
    private changeHistory;
    private watchers;
    private validationCache;
    private hotReloadEnabled;
    private configFileWatchers;
    constructor(schema?: ConfigurationSchema);
    loadConfiguration(): Promise<ValidationResult>;
    get(path: string, defaultValue?: any): any;
    set(path: string, value: any, source?: string, user?: string): Promise<ValidationResult>;
    watch(path: string, callback: (config: any) => void): void;
    unwatch(path: string, callback?: (config: any) => void): void;
    hotReload(): Promise<ValidationResult>;
    getSchema(): ConfigurationSchema;
    updateSchema(newSchema: ConfigurationSchema): void;
    getChangeHistory(limit?: number): ConfigurationChange[];
    exportConfiguration(): any;
    importConfiguration(backup: any): Promise<ValidationResult>;
    getStats(): any;
    cleanup(): void;
    private initializeDefaultLayers;
    private loadEnvironmentVariables;
    private loadConfigurationFiles;
    private loadRedisConfiguration;
    private loadRuntimeConfiguration;
    private mergeConfigurationLayers;
    private validateConfiguration;
    private validatePath;
    private validateType;
    private validateField;
    private setupFileWatchers;
    private notifyWatchers;
    private persistRuntimeChange;
    private setPathValue;
    private setNestedValue;
    private deepMerge;
}
export declare function getEnterpriseConfigManager(schema?: ConfigurationSchema): EnterpriseConfigurationManager;
export declare const DEFAULT_CONFIG_SCHEMA: ConfigurationSchema;
//# sourceMappingURL=enterprise-config.d.ts.map