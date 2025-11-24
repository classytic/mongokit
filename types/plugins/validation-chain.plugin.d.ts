export function validationChainPlugin(validators?: any[], options?: {}): {
    name: string;
    apply(repo: any): void;
};
export function blockIf(name: string, operations: string[], condition: Function, errorMessage: string): {
    name: string;
    operations: string[];
    validate: (context: any) => void;
};
export function requireField(field: any, operations?: string[]): {
    name: string;
    operations: string[];
    validate: (context: any) => void;
};
export function autoInject(field: any, getter: any, operations?: string[]): {
    name: string;
    operations: string[];
    validate: (context: any) => void;
};
export function immutableField(field: any): {
    name: string;
    operations: string[];
    validate: (context: any) => void;
};
export function uniqueField(field: any, errorMessage: any): {
    name: string;
    operations: string[];
    validate: (context: any, repo: any) => Promise<void>;
};
export default validationChainPlugin;
//# sourceMappingURL=validation-chain.plugin.d.ts.map