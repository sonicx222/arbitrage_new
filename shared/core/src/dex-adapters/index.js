"use strict";
/**
 * DEX Adapters Module
 *
 * Vault-model and pool-model DEX adapters for non-factory pattern DEXes.
 *
 * Supported DEXes:
 * - Balancer V2 / Beethoven X: Vault model with poolIds
 * - GMX: Single vault with token whitelist
 * - Platypus: Pool model for stablecoins
 *
 * @see ADR-003: Partitioned Detector Strategy
 */
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetAdapterRegistry = exports.getAdapterRegistry = exports.AdapterRegistry = exports.PlatypusAdapter = exports.GmxAdapter = exports.BalancerV2Adapter = void 0;
// Types
__exportStar(require("./types"), exports);
// Adapters
var balancer_v2_adapter_1 = require("./balancer-v2-adapter");
Object.defineProperty(exports, "BalancerV2Adapter", { enumerable: true, get: function () { return balancer_v2_adapter_1.BalancerV2Adapter; } });
var gmx_adapter_1 = require("./gmx-adapter");
Object.defineProperty(exports, "GmxAdapter", { enumerable: true, get: function () { return gmx_adapter_1.GmxAdapter; } });
var platypus_adapter_1 = require("./platypus-adapter");
Object.defineProperty(exports, "PlatypusAdapter", { enumerable: true, get: function () { return platypus_adapter_1.PlatypusAdapter; } });
// Registry
var adapter_registry_1 = require("./adapter-registry");
Object.defineProperty(exports, "AdapterRegistry", { enumerable: true, get: function () { return adapter_registry_1.AdapterRegistry; } });
Object.defineProperty(exports, "getAdapterRegistry", { enumerable: true, get: function () { return adapter_registry_1.getAdapterRegistry; } });
Object.defineProperty(exports, "resetAdapterRegistry", { enumerable: true, get: function () { return adapter_registry_1.resetAdapterRegistry; } });
//# sourceMappingURL=index.js.map