export interface User {
    id: string;
    username: string;
    email: string;
    roles: string[];
    permissions: string[];
    isActive: boolean;
    lastLogin?: Date;
}
export interface AuthToken {
    userId: string;
    username: string;
    roles: string[];
    permissions: string[];
    iat: number;
    exp: number;
}
export interface LoginRequest {
    username: string;
    password: string;
}
export interface RegisterRequest {
    username: string;
    email: string;
    password: string;
}
export declare class AuthService {
    private jwtSecret;
    private jwtExpiresIn;
    private bcryptRounds;
    private redis;
    private maxLoginAttempts;
    private lockoutDuration;
    constructor();
    private initializeRedis;
    register(request: RegisterRequest): Promise<User>;
    login(request: LoginRequest): Promise<{
        user: User;
        token: string;
    }>;
    validateToken(token: string): Promise<User | null>;
    authorize(user: User, resource: string, action: string): Promise<boolean>;
    refreshToken(token: string): Promise<string>;
    logout(token: string): Promise<void>;
    private generateToken;
    private validateRegistrationRequest;
    private validateLoginRequest;
    private isValidEmail;
    private isStrongPassword;
    private matchesPermission;
    private findUserByUsername;
    private findUserByEmail;
    private findUserById;
    private getUserPasswordHash;
    private saveUser;
    private updateUser;
    private getRolePermissions;
    private generateUserId;
    private checkAccountLockout;
    private recordFailedAttempt;
    private clearFailedAttempts;
    unlockAccount(username: string): Promise<void>;
}
export declare function authenticate(required?: boolean): (req: any, res: any, next: any) => Promise<any>;
export declare function authorize(resource: string, action: string): (req: any, res: any, next: any) => Promise<any>;
//# sourceMappingURL=auth.d.ts.map