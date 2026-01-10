import { Request, Response, NextFunction } from 'express';
export declare const validateArbitrageRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateHealthRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateMetricsRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateConfigUpdate: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateLoginRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateRegisterRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const validateWebhookRequest: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const sanitizeInput: (req: Request, res: Response, next: NextFunction) => void;
export declare const createRateLimitRule: (windowMs: number, maxRequests: number, message?: string) => {
    windowMs: number;
    max: number;
    message: string;
    standardHeaders: boolean;
    legacyHeaders: boolean;
    handler: (req: Request, res: Response) => void;
};
//# sourceMappingURL=validation.d.ts.map