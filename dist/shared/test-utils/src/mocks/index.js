"use strict";
/**
 * Mock Exports Index
 *
 * Centralized exports for all test mocks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupRedisMock = exports.createIoredisMockModule = exports.createRedisMock = exports.RedisMock = void 0;
var redis_mock_1 = require("./redis.mock");
Object.defineProperty(exports, "RedisMock", { enumerable: true, get: function () { return redis_mock_1.RedisMock; } });
Object.defineProperty(exports, "createRedisMock", { enumerable: true, get: function () { return redis_mock_1.createRedisMock; } });
Object.defineProperty(exports, "createIoredisMockModule", { enumerable: true, get: function () { return redis_mock_1.createIoredisMockModule; } });
Object.defineProperty(exports, "setupRedisMock", { enumerable: true, get: function () { return redis_mock_1.setupRedisMock; } });
//# sourceMappingURL=index.js.map