import { getFieldsForUser } from '../utils/field-selection.js';

export const fieldFilterPlugin = (fieldPreset) => ({
  name: 'fieldFilter',

  apply(repo) {
    const applyFieldFiltering = (context) => {
      if (!fieldPreset) return;

      const user = context.context?.user || context.user;
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
});

export default fieldFilterPlugin;
