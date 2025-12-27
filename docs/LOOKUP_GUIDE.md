# Custom Field Joins with MongoKit

## The Problem: Beyond ObjectId References

Traditional Mongoose populate only works with ObjectId references:

```typescript
// ❌ Traditional approach - requires ObjectId
const employeeSchema = new Schema({
  name: String,
  department: { type: ObjectId, ref: 'Department' } // Must be ObjectId
});

await Employee.find().populate('department'); // Only works with ObjectId
```

**Real-world needs:**
- Join on **slugs** for SEO-friendly URLs
- Join on **SKUs** for product catalogs
- Join on **codes** for warehouse systems
- Join on **usernames** instead of user IDs

## The Solution: $lookup with MongoKit

MongoKit provides **three powerful approaches** for custom field joins:

### 1️⃣ Repository Method (Easiest)

Use `lookupPopulate()` for simple, paginated joins:

```typescript
import { Repository } from '@classytic/mongokit';

const employeeRepo = new Repository(EmployeeModel);

// Join employees with departments using slug
const result = await employeeRepo.lookupPopulate({
  filters: { status: 'active' },
  lookups: [
    {
      from: 'departments',           // Collection to join
      localField: 'departmentSlug',   // Field in employees
      foreignField: 'slug',           // Field in departments (indexed!)
      as: 'department',               // Output field name
      single: true                    // Unwrap array to single object
    }
  ],
  sort: '-createdAt',
  page: 1,
  limit: 50
});

console.log(result.data[0]);
// {
//   _id: '...',
//   name: 'John Doe',
//   departmentSlug: 'engineering',
//   department: {              // ← Joined document
//     _id: '...',
//     slug: 'engineering',
//     name: 'Engineering Department'
//   }
// }
```

**Multiple lookups:**

```typescript
const products = await productRepo.lookupPopulate({
  filters: { inStock: true },
  lookups: [
    {
      from: 'categories',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      single: true
    },
    {
      from: 'brands',
      localField: 'brandCode',
      foreignField: 'code',
      as: 'brand',
      single: true
    }
  ],
  select: 'name,price,category,brand', // Only return specific fields
  page: 1,
  limit: 20
});
```

---

### 2️⃣ Standalone LookupBuilder (Most Flexible)

For full control, use `LookupBuilder` directly:

```typescript
import { LookupBuilder } from '@classytic/mongokit';

// Build lookup stages
const lookupStages = new LookupBuilder('departments')
  .localField('departmentSlug')
  .foreignField('slug')
  .as('department')
  .single()
  .build();

// Use with any aggregation
const employees = await EmployeeModel.aggregate([
  { $match: { status: 'active' } },
  ...lookupStages,
  { $sort: { createdAt: -1 } },
  { $limit: 50 }
]);
```

**Advanced: Lookup with pipeline (filtering joined docs)**

```typescript
const lookup = new LookupBuilder('products')
  .localField('productIds')
  .foreignField('sku')
  .as('products')
  .pipeline([
    { $match: { status: 'active', inStock: true } },  // Only active products
    { $project: { name: 1, price: 1, imageUrl: 1 } }, // Select fields
    { $sort: { priority: -1 } },                      // Sort joined docs
    { $limit: 10 }                                    // Limit joined docs
  ])
  .build();

const orders = await OrderModel.aggregate([
  { $match: { userId: currentUserId } },
  ...lookup
]);
```

**Static helpers for quick lookups:**

```typescript
// Simple one-liner
const stages = LookupBuilder.simple('departments', 'deptSlug', 'slug', {
  as: 'dept',
  single: true
});

// Multiple lookups at once
const stages = LookupBuilder.multiple([
  { from: 'categories', localField: 'categorySlug', foreignField: 'slug', single: true },
  { from: 'brands', localField: 'brandCode', foreignField: 'code', single: true }
]);
```

---

### 3️⃣ AggregationBuilder (Most Powerful)

For complex queries, use the fluent aggregation builder:

```typescript
import { AggregationBuilder } from '@classytic/mongokit';

const pipeline = new AggregationBuilder()
  .match({ status: 'active' })
  .lookup('departments', 'deptSlug', 'slug', 'department', true)
  .lookup('managers', 'managerId', '_id', 'manager', true)
  .addFields({
    fullName: { $concat: ['$firstName', ' ', '$lastName'] },
    departmentName: '$department.name'
  })
  .sort({ createdAt: -1 })
  .limit(50)
  .project({ password: 0, internalNotes: 0 })
  .build();

const employees = await EmployeeModel.aggregate(pipeline);
```

**Faceted pagination (get count + data in one query):**

```typescript
const pipeline = new AggregationBuilder()
  .match({ status: 'active' })
  .lookup('departments', 'deptSlug', 'slug', 'department', true)
  .facet({
    metadata: [{ $count: 'total' }],
    data: [
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]
  })
  .build();

const results = await EmployeeModel.aggregate(pipeline);
const total = results[0].metadata[0]?.total || 0;
const employees = results[0].data;
```

**Grouping with lookups:**

```typescript
const stats = await new AggregationBuilder()
  .match({ createdAt: { $gte: startDate } })
  .lookup('departments', 'deptSlug', 'slug', 'department', true)
  .group({
    _id: '$department.name',
    employeeCount: { $sum: 1 },
    avgSalary: { $avg: '$salary' },
    totalSalary: { $sum: '$salary' }
  })
  .sort({ employeeCount: -1 })
  .build();

const results = await EmployeeModel.aggregate(stats);
```

---

## 🚀 Performance: Handling Millions of Records

### Critical: Index Requirements

**Without indexes = slow (O(n*m) - avoid!)**
**With indexes = fast (O(log n) - perfect!)**

```typescript
// ✅ REQUIRED INDEXES for fast lookups

// Employee collection (source)
employeeSchema.index({ departmentSlug: 1 });

// Department collection (target)
departmentSchema.index({ slug: 1 }, { unique: true });

// Product example
productSchema.index({ categorySlug: 1, brandCode: 1 });
categorySchema.index({ slug: 1 }, { unique: true });
brandSchema.index({ code: 1 }, { unique: true });
```

### Verify Index Usage

Always check that MongoDB uses indexes (not collection scans):

```typescript
const pipeline = new AggregationBuilder()
  .match({ status: 'active' })
  .lookup('departments', 'deptSlug', 'slug', 'department', true)
  .build();

// Check query plan
const explain = await EmployeeModel.aggregate(pipeline).explain();
console.log(explain);

// Look for: "IXSCAN" (index scan) ✅
// Avoid: "COLLSCAN" (collection scan) ❌
```

### Performance Optimization Tips

```typescript
// 1. ✅ Filter BEFORE lookup (reduce documents to join)
new AggregationBuilder()
  .match({ status: 'active', createdAt: { $gte: startDate } }) // ← Filter first!
  .lookup('departments', 'deptSlug', 'slug', 'department', true)

// 2. ✅ Project BEFORE lookup (reduce field size)
new AggregationBuilder()
  .match({ status: 'active' })
  .project({ password: 0, largeField: 0 }) // ← Remove large fields
  .lookup('departments', 'deptSlug', 'slug', 'department', true)

// 3. ✅ Use pipeline to limit joined documents
new LookupBuilder('products')
  .localField('productIds')
  .foreignField('sku')
  .pipeline([
    { $match: { inStock: true } },  // Filter joined docs
    { $limit: 5 }                   // Limit joined docs
  ])

// 4. ✅ For very large datasets, enable disk use
await EmployeeModel.aggregate(pipeline).allowDiskUse(true);
```

---

## 🌐 URL Query Integration

Use the `QueryParser` to parse URL parameters with lookup support:

```typescript
import { QueryParser } from '@classytic/mongokit';

const parser = new QueryParser({ enableLookups: true });

// URL: /api/employees?status=active&lookup[department][foreignField]=slug&lookup[department][localField]=deptSlug&page=1
const parsed = parser.parse(req.query);

console.log(parsed);
// {
//   filters: { status: 'active' },
//   lookups: [{
//     from: 'departments',
//     localField: 'deptSlug',
//     foreignField: 'slug',
//     as: 'department',
//     single: true
//   }],
//   page: 1,
//   limit: 20
// }

// Use directly with repository
const result = await employeeRepo.lookupPopulate({
  filters: parsed.filters,
  lookups: parsed.lookups,
  page: parsed.page,
  limit: parsed.limit
});
```

**Simple URL syntax:**

```
# Join with departments on slug
/api/employees?lookup[department]=slug

# Join with multiple collections
/api/products?lookup[category]=slug&lookup[brand]=code

# Full control
/api/employees?lookup[department][localField]=deptSlug&lookup[department][foreignField]=slug&lookup[department][single]=true
```

---

## 📊 Real-World Examples

### Example 1: E-commerce Product Catalog

```typescript
// Schema setup
const productSchema = new Schema({
  name: String,
  sku: { type: String, unique: true, index: true },
  categorySlug: { type: String, index: true },
  brandCode: { type: String, index: true },
  price: Number,
  inStock: Boolean
});

const categorySchema = new Schema({
  slug: { type: String, unique: true, index: true },
  name: String
});

const brandSchema = new Schema({
  code: { type: String, unique: true, index: true },
  name: String
});

// Query with joins
const productRepo = new Repository(ProductModel);

const catalog = await productRepo.lookupPopulate({
  filters: { inStock: true, price: { $lte: 1000 } },
  lookups: [
    {
      from: 'categories',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      single: true
    },
    {
      from: 'brands',
      localField: 'brandCode',
      foreignField: 'code',
      as: 'brand',
      single: true
    }
  ],
  sort: '-createdAt',
  select: 'name,sku,price,category,brand',
  page: 1,
  limit: 24
});

// Result:
// {
//   data: [
//     {
//       name: 'Gaming Laptop',
//       sku: 'LAP-001',
//       price: 899,
//       category: { slug: 'laptops', name: 'Laptops' },
//       brand: { code: 'ASUS', name: 'ASUS' }
//     }
//   ],
//   total: 156,
//   page: 1,
//   limit: 24
// }
```

### Example 2: Employee Management System

```typescript
const employeeSchema = new Schema({
  firstName: String,
  lastName: String,
  departmentSlug: { type: String, index: true },
  managerId: { type: ObjectId, ref: 'Employee' },
  salary: Number,
  status: String
});

// Complex aggregation with multiple joins
const stats = await new AggregationBuilder()
  .match({ status: 'active' })
  .lookup('departments', 'departmentSlug', 'slug', 'department', true)
  .lookup('employees', 'managerId', '_id', 'manager', true)
  .addFields({
    fullName: { $concat: ['$firstName', ' ', '$lastName'] },
    departmentName: '$department.name',
    managerName: { $concat: ['$manager.firstName', ' ', '$manager.lastName'] }
  })
  .facet({
    byDepartment: [
      {
        $group: {
          _id: '$departmentName',
          count: { $sum: 1 },
          avgSalary: { $avg: '$salary' }
        }
      },
      { $sort: { count: -1 } }
    ],
    topEarners: [
      { $sort: { salary: -1 } },
      { $limit: 10 },
      { $project: { fullName: 1, salary: 1, departmentName: 1 } }
    ]
  })
  .build();

const results = await EmployeeModel.aggregate(stats);
```

### Example 3: Warehouse Inventory System

```typescript
// Join orders with warehouses by location code
const orderRepo = new Repository(OrderModel);

const fulfillment = await orderRepo.lookupPopulate({
  filters: {
    status: 'pending',
    region: 'NA'
  },
  lookups: [
    {
      from: 'warehouses',
      localField: 'warehouseCode',
      foreignField: 'code',
      as: 'warehouse',
      single: true,
      pipeline: [
        { $match: { operational: true } },
        { $project: { name: 1, code: 1, capacity: 1, currentLoad: 1 } }
      ]
    },
    {
      from: 'products',
      localField: 'items.sku',
      foreignField: 'sku',
      as: 'productDetails'
    }
  ],
  sort: 'priority,-createdAt',
  limit: 100
});
```

---

## 🆚 Comparison with Alternatives

### vs. Traditional Populate

```typescript
// ❌ Traditional populate - Only works with ObjectId
await Employee.find().populate('department');

// ✅ MongoKit lookup - Works with ANY field
await employeeRepo.lookupPopulate({
  lookups: [{
    from: 'departments',
    localField: 'departmentSlug',  // ← Any field!
    foreignField: 'slug',           // ← Any field!
    single: true
  }]
});
```

### vs. Prisma

```typescript
// Prisma - Requires relation definitions in schema
model Employee {
  department   Department @relation(fields: [departmentId], references: [id])
  departmentId Int        // Must be ID field
}

// ✅ MongoKit - No schema changes needed
await employeeRepo.lookupPopulate({
  lookups: [{
    from: 'departments',
    localField: 'departmentSlug', // Use existing field
    foreignField: 'slug',
    single: true
  }]
});
```

### vs. Raw Aggregation

```typescript
// ❌ Raw aggregation - Verbose and error-prone
await Employee.aggregate([
  { $match: { status: 'active' } },
  {
    $lookup: {
      from: 'departments',
      localField: 'departmentSlug',
      foreignField: 'slug',
      as: 'department'
    }
  },
  { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
  { $sort: { createdAt: -1 } },
  { $skip: 0 },
  { $limit: 50 }
]);

// ✅ MongoKit - Clean and concise
await employeeRepo.lookupPopulate({
  filters: { status: 'active' },
  lookups: [{ from: 'departments', localField: 'departmentSlug', foreignField: 'slug', single: true }],
  sort: '-createdAt',
  page: 1,
  limit: 50
});
```

---

## 🎯 Best Practices

### 1. **Always Index Join Fields**
```typescript
// Both collections must have indexes
employeeSchema.index({ departmentSlug: 1 });
departmentSchema.index({ slug: 1 }, { unique: true });
```

### 2. **Use `single: true` for 1:1 Relationships**
```typescript
// ❌ Without single - returns array
{ department: [{ slug: 'eng', name: 'Engineering' }] }

// ✅ With single - returns object
{ department: { slug: 'eng', name: 'Engineering' } }
```

### 3. **Filter Before Joining**
```typescript
// ✅ Good - filter first
.match({ status: 'active' })
.lookup(...)

// ❌ Bad - join then filter
.lookup(...)
.match({ status: 'active' })
```

### 4. **Use Pipelines to Limit Joined Docs**
```typescript
{
  from: 'products',
  localField: 'productIds',
  foreignField: 'sku',
  pipeline: [
    { $match: { inStock: true } },
    { $limit: 10 }  // Only get 10 products per order
  ]
}
```

### 5. **Consider Caching for Hot Paths**
```typescript
import { cachePlugin } from '@classytic/mongokit';

const productRepo = new Repository(ProductModel, [
  cachePlugin({ ttl: 300 }) // Cache for 5 minutes
]);

// Subsequent calls use cache
const products = await productRepo.lookupPopulate({ ... });
```

---

## 🔧 Troubleshooting

### Query is Slow

1. **Check indexes:**
   ```typescript
   await EmployeeModel.collection.getIndexes();
   await DepartmentModel.collection.getIndexes();
   ```

2. **Use explain():**
   ```typescript
   const pipeline = [...];
   const explain = await EmployeeModel.aggregate(pipeline).explain();
   console.log(explain);
   // Look for "IXSCAN" not "COLLSCAN"
   ```

3. **Enable query logging:**
   ```typescript
   mongoose.set('debug', true);
   ```

### Lookups Return Empty

- Ensure field values match exactly (case-sensitive)
- Check that foreign collection exists
- Verify data exists in both collections

### Type Errors

Use proper TypeScript types:
```typescript
import type { LookupOptions } from '@classytic/mongokit';

const lookups: LookupOptions[] = [
  {
    from: 'departments',
    localField: 'departmentSlug',
    foreignField: 'slug',
    as: 'department',
    single: true
  }
];
```

---

## 📚 Summary

MongoKit provides **three ways** to perform custom field joins:

| Approach | Use Case | Complexity |
|----------|----------|------------|
| `repo.lookupPopulate()` | Simple paginated queries | ⭐ Easy |
| `LookupBuilder` | Standalone lookup stages | ⭐⭐ Medium |
| `AggregationBuilder` | Complex aggregations | ⭐⭐⭐ Advanced |

**Performance at scale:**
- ✅ Properly indexed: O(log n) - handles millions of records
- ❌ Not indexed: O(n*m) - slow for large datasets

**Remember:**
1. Always index both `localField` and `foreignField`
2. Filter before joining when possible
3. Use pipelines to limit joined documents
4. Verify with `explain()` that indexes are used

Happy coding! 🚀
