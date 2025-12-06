/**
 * Field Filter Plugin
 * Automatically filters response fields based on user roles
 */

import { getFieldsForUser } from '../utils/field-selection.js';
import type { Plugin, RepositoryContext, RepositoryInstance, FieldPreset } from '../types.js';

/**
 * Field filter plugin that restricts fields based on user context
 * 
 * @example
 * const fieldPreset = {
 *   public: ['id', 'name'],
 *   authenticated: ['email'],
 *   admin: ['createdAt', 'internalNotes']
 * };
 * 
 * const repo = new Repository(Model, [fieldFilterPlugin(fieldPreset)]);
 */
export function fieldFilterPlugin(fieldPreset: FieldPreset): Plugin {
  return {
    name: 'fieldFilter',

    apply(repo: RepositoryInstance): void {
      const applyFieldFiltering = (context: RepositoryContext): void => {
        if (!fieldPreset) return;

        const user = (context as any).context?.user || (context as any).user;
        const fields = getFieldsForUser(user, fieldPreset);
        const presetSelect = fields.join(' ');

        if (context.select) {
          context.select = `${presetSelect} ${context.select}`;
        } else {
          context.select = presetSelect;
        }
      };

      repo.on('before:getAll', applyFieldFiltering);
      repo.on('before:getById', applyFieldFiltering);
      repo.on('before:getByQuery', applyFieldFiltering);
    },
  };
}

export default fieldFilterPlugin;
