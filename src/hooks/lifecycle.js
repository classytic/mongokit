/**
 * Lifecycle Hooks
 * Event system for repository actions
 */

import { EventEmitter } from 'events';

export class RepositoryLifecycle extends EventEmitter {
  constructor() {
    super();
    this.hooks = new Map();
  }

  /**
   * Register hook
   */
  on(event, handler) {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event).push(handler);
    return super.on(event, handler);
  }

  /**
   * Execute hooks before action
   */
  async runBeforeHooks(action, context) {
    const event = `before:${action}`;
    await this.emit(event, context);
    
    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context);
    }
  }

  /**
   * Execute hooks after action
   */
  async runAfterHooks(action, context, result) {
    const event = `after:${action}`;
    await this.emit(event, context, result);
    
    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context, result);
    }
  }

  /**
   * Execute hooks on error
   */
  async runErrorHooks(action, context, error) {
    const event = `error:${action}`;
    await this.emit(event, context, error);
    
    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await hook(context, error);
    }
  }
}

/**
 * Hook decorators for common patterns
 */
export const hooks = {
  /**
   * Auto-timestamp before create/update
   */
  autoTimestamp: () => ({
    'before:create': (context) => {
      context.data.createdAt = new Date();
      context.data.updatedAt = new Date();
    },
    'before:update': (context) => {
      context.data.updatedAt = new Date();
    },
  }),

  /**
   * Auto-inject user context
   */
  autoUser: (userField = 'userId') => ({
    'before:create': (context) => {
      if (context.user && !context.data[userField]) {
        context.data[userField] = context.user._id || context.user.id;
      }
    },
  }),

  /**
   * Auto-inject organization scope
   */
  autoOrganization: (orgField = 'organizationId') => ({
    'before:create': (context) => {
      if (context.organizationId && !context.data[orgField]) {
        context.data[orgField] = context.organizationId;
      }
    },
  }),

  /**
   * Audit log
   */
  auditLog: (logger) => ({
    'after:create': (context, result) => {
      logger.info('Document created', {
        model: context.model,
        id: result._id,
        user: context.user?.id,
      });
    },
    'after:update': (context, result) => {
      logger.info('Document updated', {
        model: context.model,
        id: result._id,
        user: context.user?.id,
      });
    },
    'after:delete': (context, result) => {
      logger.info('Document deleted', {
        model: context.model,
        user: context.user?.id,
      });
    },
  }),

  /**
   * Cache invalidation
   */
  cacheInvalidation: (cache) => ({
    'after:create': async (context, result) => {
      await cache.invalidate(`${context.model}:*`);
    },
    'after:update': async (context, result) => {
      await cache.invalidate(`${context.model}:${result._id}`);
      await cache.invalidate(`${context.model}:*`);
    },
    'after:delete': async (context) => {
      await cache.invalidate(`${context.model}:*`);
    },
  }),
};

