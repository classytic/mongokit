export class RepositoryLifecycle extends EventEmitter<[never]> {
    constructor();
    hooks: Map<any, any>;
    /**
     * Register hook
     */
    on(event: any, handler: any): this;
    /**
     * Execute hooks before action
     */
    runBeforeHooks(action: any, context: any): Promise<void>;
    /**
     * Execute hooks after action
     */
    runAfterHooks(action: any, context: any, result: any): Promise<void>;
    /**
     * Execute hooks on error
     */
    runErrorHooks(action: any, context: any, error: any): Promise<void>;
}
export namespace hooks {
    function autoTimestamp(): {
        'before:create': (context: any) => void;
        'before:update': (context: any) => void;
    };
    function autoUser(userField?: string): {
        'before:create': (context: any) => void;
    };
    function autoOrganization(orgField?: string): {
        'before:create': (context: any) => void;
    };
    function auditLog(logger: any): {
        'after:create': (context: any, result: any) => void;
        'after:update': (context: any, result: any) => void;
        'after:delete': (context: any, result: any) => void;
    };
    function cacheInvalidation(cache: any): {
        'after:create': (context: any, result: any) => Promise<void>;
        'after:update': (context: any, result: any) => Promise<void>;
        'after:delete': (context: any) => Promise<void>;
    };
}
import { EventEmitter } from 'events';
//# sourceMappingURL=lifecycle.d.ts.map