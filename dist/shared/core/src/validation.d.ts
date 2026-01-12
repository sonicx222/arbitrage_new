import Joi from 'joi';
export declare class ValidationMiddleware {
    static validateArbitrageOpportunity: (req: any, res: any, next: any) => any;
    static validateHealthCheck: (req: any, res: any, next: any) => any;
    static validateApiKey: (req: any, res: any, next: any) => any;
    static sanitizeString: (input: string, maxLength?: number) => string;
    static sanitizeNumber: (input: any, min?: number, max?: number) => number | null;
}
export declare const ValidationSchemas: {
    arbitrageOpportunity: Joi.ObjectSchema<any>;
    serviceHealth: Joi.ObjectSchema<any>;
    tradeExecution: Joi.ObjectSchema<any>;
};
//# sourceMappingURL=validation.d.ts.map