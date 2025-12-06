/**
 * Lifecycle Hooks
 * Event system for repository actions
 */

import { EventEmitter } from 'events';
import type { RepositoryContext, Logger } from '../types.js';

type HookHandler = (context: RepositoryContext, result?: unknown) => void | Promise<void>;

/**
 * Repository lifecycle event emitter
 */
export class RepositoryLifecycle extends EventEmitter {
  public readonly hooks: Map<string, HookHandler[]>;

  constructor() {
    super();
    this.hooks = new Map();
  }

  /**
   * Register hook
   */
  on(event: string, handler: HookHandler): this {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(handler);
    return super.on(event, handler as (...args: unknown[]) => void);
  }

  /**
   * Execute hooks before action
   */
  async runBeforeHooks(action: string, context: RepositoryContext): Promise<void> {
    const event = `before:${action}`;
    this.emit(event, context);

    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context);
    }
  }

  /**
   * Execute hooks after action
   */
  async runAfterHooks(action: string, context: RepositoryContext, result: unknown): Promise<void> {
    const event = `after:${action}`;
    this.emit(event, context, result);

    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context, result);
    }
  }

  /**
   * Execute hooks on error
   */
  async runErrorHooks(action: string, context: RepositoryContext, error: Error): Promise<void> {
    const event = `error:${action}`;
    this.emit(event, context, error);

    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context, error);
    }
  }
}

/**
 * Cache interface for cache invalidation hook
 */
interface Cache {
  invalidate(pattern: string): Promise<void>;
}

/**
 * Hook decorators for common patterns
 */
export const hooks = {
  /**
   * Auto-timestamp before create/update
   */
  autoTimestamp: () => ({
    'before:create': (context: RepositoryContext) => {
      if (!context.data) return;
      const now = new Date();
      if (!context.data.createdAt) context.data.createdAt = now;
      if (!context.data.updatedAt) context.data.updatedAt = now;
    },
    'before:update': (context: RepositoryContext) => {
      if (!context.data) return;
      context.data.updatedAt = new Date();
    },
  }),

  /**
   * Auto-inject user context
   */
  autoUser: (userField: string = 'userId') => ({
    'before:create': (context: RepositoryContext) => {
      if (context.user && context.data && !context.data[userField]) {
        context.data[userField] = context.user._id || context.user.id;
      }
    },
  }),

  /**
   * Auto-inject organization scope
   */
  autoOrganization: (orgField: string = 'organizationId') => ({
    'before:create': (context: RepositoryContext) => {
      if (context.organizationId && context.data && !context.data[orgField]) {
        context.data[orgField] = context.organizationId;
      }
    },
  }),

  /**
   * Audit log
   */
  auditLog: (logger: Logger) => ({
    'after:create': (context: RepositoryContext, result: unknown) => {
      logger.info?.('Document created', {
        model: context.model,
        id: (result as Record<string, unknown>)?._id,
        user: context.user?.id,
      });
    },
    'after:update': (context: RepositoryContext, result: unknown) => {
      logger.info?.('Document updated', {
        model: context.model,
        id: (result as Record<string, unknown>)?._id,
        user: context.user?.id,
      });
    },
    'after:delete': (context: RepositoryContext) => {
      logger.info?.('Document deleted', {
        model: context.model,
        user: context.user?.id,
      });
    },
  }),

  /**
   * Cache invalidation
   */
  cacheInvalidation: (cache: Cache) => ({
    'after:create': async (context: RepositoryContext) => {
      await cache.invalidate(`${context.model}:*`);
    },
    'after:update': async (context: RepositoryContext, result: unknown) => {
      await cache.invalidate(`${context.model}:${(result as Record<string, unknown>)?._id}`);
      await cache.invalidate(`${context.model}:*`);
    },
    'after:delete': async (context: RepositoryContext) => {
      await cache.invalidate(`${context.model}:*`);
    },
  }),
};
