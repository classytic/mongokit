/**
 * Subdocument Plugin
 * Adds subdocument array operations
 */

import createError from 'http-errors';

export const subdocumentPlugin = () => ({
  name: 'subdocument',

  apply(repo) {
    if (!repo.registerMethod) {
      throw new Error('subdocumentPlugin requires methodRegistryPlugin');
    }

    /**
     * Add subdocument to array
     */
    repo.registerMethod('addSubdocument', async function (parentId, arrayPath, subData, options = {}) {
      return this.update(parentId, { $push: { [arrayPath]: subData } }, options);
    });

    /**
     * Get subdocument from array
     */
    repo.registerMethod('getSubdocument', async function (parentId, arrayPath, subId, options = {}) {
      return this._executeQuery(async (Model) => {
        const parent = await Model.findById(parentId).session(options.session).exec();
        if (!parent) throw createError(404, 'Parent not found');

        const sub = parent[arrayPath].id(subId);
        if (!sub) throw createError(404, 'Subdocument not found');

        return options.lean ? sub.toObject() : sub;
      });
    });

    /**
     * Update subdocument in array
     */
    repo.registerMethod('updateSubdocument', async function (parentId, arrayPath, subId, updateData, options = {}) {
      return this._executeQuery(async (Model) => {
        const query = { _id: parentId, [`${arrayPath}._id`]: subId };
        const update = { $set: { [`${arrayPath}.$`]: { ...updateData, _id: subId } } };

        const result = await Model.findOneAndUpdate(query, update, {
          new: true,
          runValidators: true,
          session: options.session,
        }).exec();

        if (!result) throw createError(404, 'Parent or subdocument not found');
        return result;
      });
    });

    /**
     * Delete subdocument from array
     */
    repo.registerMethod('deleteSubdocument', async function (parentId, arrayPath, subId, options = {}) {
      return this.update(parentId, { $pull: { [arrayPath]: { _id: subId } } }, options);
    });
  }
});

export default subdocumentPlugin;
