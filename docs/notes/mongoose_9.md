Web search results for query: "Mongoose 9 migration guide breaking changes 2024"

Links: [{"title":"Mongoose v9.0.2: Migrating to Mongoose 9","url":"https://mongoosejs.com/docs/migrating_to_9.html"},{"title":"Mongoose v9.0.1: Migration Guide","url":"https://mongoosejs.com/docs/migration.html"},{"title":"Migrate to 9.0.0 | typegoose","url":"https://typegoose.github.io/typegoose/docs/guides/migration/migrate-9/"},{"title":"Mongoose v9.0.2: Migrating to Mongoose 6","url":"https://mongoosejs.com/docs/migrating_to_6.html"},{"title":"Releases · Automattic/mongoose","url":"https://github.com/Automattic/mongoose/releases"},{"title":"Mongoose v9.0.2: Migrating to Mongoose 8","url":"https://mongoosejs.com/docs/migrating_to_8.html"},{"title":"Mongoose v9.0.1: Migrating to Mongoose 5","url":"https://mongoosejs.com/docs/migrating_to_5.html"},{"title":"mongoose - npm","url":"https://www.npmjs.com/package/mongoose"},{"title":"Mongoose version upgrade - MongoDB for Academia - MongoDB Community Hub","url":"https://www.mongodb.com/community/forums/t/mongoose-version-upgrade/286505"},{"title":"How To Properly Handle Mongoose Schema Migrations? - GeeksforGeeks","url":"https://www.geeksforgeeks.org/mongodb/how-to-properly-handle-mongoose-schema-migrations/"}]

I found the official Mongoose 9 migration guide. Here are the key breaking changes:

## Major Breaking Changes in Mongoose 9

Mongoose 9.0.0 was released on November 21, 2025. Here are the most significant breaking changes:

### 1. **Pre Middleware No Longer Accepts `next()` Parameter**
In Mongoose 9, pre middleware no longer receives a next() parameter. Instead, you should use async functions or promises to handle async pre middleware.

### 2. **Schema.doValidate() Now Returns a Promise**
Schema.prototype.doValidate() now returns a promise that rejects with a validation error if one occurred.

### 3. **Stricter TypeScript Query Types**
The TypeScript types are now stricter for queries, which may cause compilation errors for invalid query filters or operators that previously worked in Mongoose 8.

### 4. **ObjectId Validation Changes**
In Mongoose 9, isValidObjectId() will return false for numbers and you can no longer create a new ObjectId from a number.

### 5. **Update Pipelines Require Explicit Opt-in**
Mongoose does not cast update pipelines at all, so for Mongoose 9 we've made using update pipelines throw an error by default. You need to set `updatePipeline: true` to enable them.

### Migration Recommendation
If you're still on Mongoose 7.x or earlier, please read the Mongoose 7.x to 8.x migration guide and upgrade to Mongoose 8.x first before upgrading to Mongoose 9.

You can find the complete migration guide at: https://mongoosejs.com/docs/migrating_to_9.html
