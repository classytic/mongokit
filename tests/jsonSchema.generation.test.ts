/**
 * JSON Schema Generation Tests
 *
 * Tests for Fastify/Swagger schema generation with validators
 */

import { describe, it, expect } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { buildCrudSchemasFromMongooseSchema, buildCrudSchemasFromModel } from '../src/index.js';

describe('JSON Schema Generation - String Validators', () => {
  it('should extract minlength validator', () => {
    const schema = new Schema({
      name: { type: String, minlength: 3, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.name).toBeDefined();
    expect(createBody.properties?.name).toHaveProperty('minLength', 3);
  });

  it('should extract maxlength validator', () => {
    const schema = new Schema({
      username: { type: String, maxlength: 20, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.username).toBeDefined();
    expect(createBody.properties?.username).toHaveProperty('maxLength', 20);
  });

  it('should extract regex match pattern', () => {
    const schema = new Schema({
      email: { type: String, match: /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.email).toBeDefined();
    expect(createBody.properties?.email).toHaveProperty('pattern');
    expect((createBody.properties?.email as any).pattern).toBe('^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$');
  });

  it('should extract both minlength and maxlength', () => {
    const schema = new Schema({
      password: { type: String, minlength: 8, maxlength: 100, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.password).toBeDefined();
    expect(createBody.properties?.password).toHaveProperty('minLength', 8);
    expect(createBody.properties?.password).toHaveProperty('maxLength', 100);
  });
});

describe('JSON Schema Generation - Number Validators', () => {
  it('should extract min validator', () => {
    const schema = new Schema({
      age: { type: Number, min: 18, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.age).toBeDefined();
    expect(createBody.properties?.age).toHaveProperty('minimum', 18);
  });

  it('should extract max validator', () => {
    const schema = new Schema({
      age: { type: Number, max: 120, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.age).toBeDefined();
    expect(createBody.properties?.age).toHaveProperty('maximum', 120);
  });

  it('should extract both min and max', () => {
    const schema = new Schema({
      score: { type: Number, min: 0, max: 100, required: true },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.score).toBeDefined();
    expect(createBody.properties?.score).toHaveProperty('minimum', 0);
    expect(createBody.properties?.score).toHaveProperty('maximum', 100);
  });
});

describe('JSON Schema Generation - Update Schema', () => {
  it('should omit immutable fields from update schema', () => {
    const schema = new Schema({
      email: { type: String, required: true },
      organizationId: { type: String, required: true },
      status: { type: String },
    });

    const { createBody, updateBody } = buildCrudSchemasFromMongooseSchema(schema, {
      fieldRules: {
        organizationId: { immutable: true },
      },
    });

    expect(createBody.properties).toHaveProperty('organizationId');
    expect(updateBody.properties).not.toHaveProperty('organizationId');
  });

  it('should enforce minProperties when requireAtLeastOne is enabled', () => {
    const schema = new Schema({
      name: { type: String },
      email: { type: String },
    });

    const { updateBody } = buildCrudSchemasFromMongooseSchema(schema, {
      update: {
        requireAtLeastOne: true,
      },
    });

    expect(updateBody).toHaveProperty('minProperties', 1);
  });

  it('should not have required fields in update schema', () => {
    const schema = new Schema({
      email: { type: String, required: true },
      name: { type: String, required: true },
    });

    const { updateBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(updateBody.required).toBeUndefined();
  });

  it('should allow empty updates when requireAtLeastOne is false', () => {
    const schema = new Schema({
      name: { type: String },
      email: { type: String },
    });

    const { updateBody } = buildCrudSchemasFromMongooseSchema(schema, {
      update: {
        requireAtLeastOne: false,
      },
    });

    expect(updateBody.minProperties).toBeUndefined();
  });
});

describe('JSON Schema Generation - Fastify/Swagger Integration', () => {
  it('should generate valid Fastify route schema structure', () => {
    const UserSchema = new Schema({
      email: { type: String, required: true, match: /^\S+@\S+\.\S+$/ },
      name: { type: String, required: true, minlength: 2, maxlength: 50 },
      age: { type: Number, min: 0, max: 150 },
      role: { type: String, enum: ['admin', 'user'], default: 'user' },
    });

    const schemas = buildCrudSchemasFromMongooseSchema(UserSchema, {
      strictAdditionalProperties: true,
      update: {
        requireAtLeastOne: true,
      },
    });

    // Create schema should have all fields
    expect(schemas.createBody.type).toBe('object');
    expect(schemas.createBody.properties).toHaveProperty('email');
    expect(schemas.createBody.properties).toHaveProperty('name');
    expect(schemas.createBody.properties).toHaveProperty('age');
    expect(schemas.createBody.properties).toHaveProperty('role');

    // Email validation
    const emailProp = schemas.createBody.properties?.email as any;
    expect(emailProp.type).toBe('string');
    expect(emailProp.pattern).toBeDefined();

    // Name validation
    const nameProp = schemas.createBody.properties?.name as any;
    expect(nameProp.type).toBe('string');
    expect(nameProp.minLength).toBe(2);
    expect(nameProp.maxLength).toBe(50);

    // Age validation
    const ageProp = schemas.createBody.properties?.age as any;
    expect(ageProp.type).toBe('number');
    expect(ageProp.minimum).toBe(0);
    expect(ageProp.maximum).toBe(150);

    // Role enum
    const roleProp = schemas.createBody.properties?.role as any;
    expect(roleProp.type).toBe('string');
    expect(roleProp.enum).toEqual(['admin', 'user']);

    // Strict additional properties
    expect(schemas.createBody.additionalProperties).toBe(false);
    expect(schemas.updateBody.additionalProperties).toBe(false);

    // Update schema minProperties
    expect(schemas.updateBody.minProperties).toBe(1);
  });

  it('should work with Fastify schema registration', () => {
    const ProductSchema = new Schema({
      name: { type: String, required: true, minlength: 3, maxlength: 100 },
      price: { type: Number, required: true, min: 0 },
      sku: { type: String, required: true, match: /^[A-Z0-9-]+$/ },
    });

    const schemas = buildCrudSchemasFromMongooseSchema(ProductSchema, {
      strictAdditionalProperties: true,
    });

    // Simulate Fastify route schema
    const fastifyRouteSchema = {
      body: schemas.createBody,
      response: {
        201: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            price: { type: 'number' },
            sku: { type: 'string' },
          },
        },
      },
    };

    expect(fastifyRouteSchema.body).toBeDefined();
    expect(fastifyRouteSchema.body.type).toBe('object');
    expect(fastifyRouteSchema.body.additionalProperties).toBe(false);

    // Validate that all validators are present
    const nameProp = fastifyRouteSchema.body.properties?.name as any;
    expect(nameProp.minLength).toBe(3);
    expect(nameProp.maxLength).toBe(100);

    const priceProp = fastifyRouteSchema.body.properties?.price as any;
    expect(priceProp.minimum).toBe(0);

    const skuProp = fastifyRouteSchema.body.properties?.sku as any;
    expect(skuProp.pattern).toBe('^[A-Z0-9-]+$');
  });

  it('should generate OpenAPI 3.0 compatible schemas', () => {
    const ArticleSchema = new Schema({
      title: { type: String, required: true, minlength: 5, maxlength: 200 },
      content: { type: String, required: true, minlength: 100 },
      publishedAt: { type: Date },
      tags: [{ type: String }],
      views: { type: Number, min: 0, default: 0 },
    });

    const schemas = buildCrudSchemasFromMongooseSchema(ArticleSchema, {
      dateAs: 'date-time',
    });

    // OpenAPI structure check
    expect(schemas.createBody.type).toBe('object');
    expect(schemas.createBody.properties).toBeDefined();
    expect(schemas.createBody.required).toContain('title');
    expect(schemas.createBody.required).toContain('content');

    // String validators for OpenAPI
    const titleProp = schemas.createBody.properties?.title as any;
    expect(titleProp.type).toBe('string');
    expect(titleProp.minLength).toBe(5);
    expect(titleProp.maxLength).toBe(200);

    // Array handling
    const tagsProp = schemas.createBody.properties?.tags as any;
    expect(tagsProp.type).toBe('array');
    expect(tagsProp.items).toBeDefined();

    // Date format for OpenAPI
    const publishedAtProp = schemas.createBody.properties?.publishedAt as any;
    expect(publishedAtProp.type).toBe('string');
    expect(publishedAtProp.format).toBe('date-time');
  });
});

describe('JSON Schema Generation - Complex Types', () => {
  it('should handle nested objects', () => {
    const schema = new Schema({
      profile: {
        firstName: { type: String, required: true, minlength: 2 },
        lastName: { type: String, required: true, minlength: 2 },
        age: { type: Number, min: 0, max: 150 },
      },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    expect(createBody.properties?.profile).toBeDefined();
    const profile = createBody.properties?.profile as any;
    expect(profile.type).toBe('object');
    expect(profile.properties).toHaveProperty('firstName');
    expect(profile.properties).toHaveProperty('lastName');
    expect(profile.properties).toHaveProperty('age');

    // Check nested validators
    expect(profile.properties.firstName.minLength).toBe(2);
    expect(profile.properties.lastName.minLength).toBe(2);
    expect(profile.properties.age.minimum).toBe(0);
    expect(profile.properties.age.maximum).toBe(150);
  });

  it('should handle array of strings', () => {
    const schema = new Schema({
      tags: [{ type: String }],
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    const tags = createBody.properties?.tags as any;
    expect(tags.type).toBe('array');
    expect(tags.items).toBeDefined();
    expect(tags.items.type).toBe('string');
  });

  it('should handle enums correctly', () => {
    const schema = new Schema({
      status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);

    const status = createBody.properties?.status as any;
    expect(status.type).toBe('string');
    expect(status.enum).toEqual(['draft', 'published', 'archived']);
  });
});
