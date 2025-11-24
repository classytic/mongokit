/**
 * NestJS Integration Example
 *
 * Shows how to use MongoKit with NestJS and @nestjs/mongoose
 */

import { Module, Injectable, Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Model, Document } from 'mongoose';
import { Repository } from '@classytic/mongokit';

// 1. Define Schema
@Schema()
export class User extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ default: 'active' })
  status: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// 2. Create Repository
@Injectable()
export class UserRepository extends Repository {
  constructor(@InjectModel(User.name) userModel: Model<User>) {
    super(userModel, [], {
      defaultLimit: 20,
      maxLimit: 100
    });
  }

  // Custom methods
  async findActiveUsers(page = 1, limit = 20) {
    return this.getAll({
      page,
      limit,
      filters: { status: 'active' },
      sort: { createdAt: -1 }
    });
  }
}

// 3. Create Controller
@Controller('users')
export class UserController {
  constructor(private readonly userRepo: UserRepository) {}

  // GET /users?page=1&limit=20&status=active
  @Get()
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('status') status?: string,
  ) {
    const result = await this.userRepo.getAll({
      page: +page,
      limit: +limit,
      ...(status && { filters: { status } }),
      sort: { createdAt: -1 }
    });

    return {
      users: result.docs,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pages: result.pages,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev
      }
    };
  }

  // GET /users/:id
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.userRepo.getById(id);
  }

  // POST /users
  @Post()
  async create(@Body() createUserDto: { name: string; email: string }) {
    return this.userRepo.create(createUserDto);
  }
}

// 4. Create Module
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])
  ],
  controllers: [UserController],
  providers: [UserRepository],
  exports: [UserRepository]
})
export class UserModule {}

// 5. App Module (connect to MongoDB)
@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/myapp'),
    UserModule
  ],
})
export class AppModule {}

/**
 * INFINITE SCROLL EXAMPLE (Cursor Pagination)
 */

@Schema()
export class Post extends Document {
  @Prop({ required: true })
  title: string;

  @Prop()
  content: string;

  @Prop({ default: Date.now })
  publishedAt: Date;
}

export const PostSchema = SchemaFactory.createForClass(Post);

@Injectable()
export class PostRepository extends Repository {
  constructor(@InjectModel(Post.name) postModel: Model<Post>) {
    super(postModel, [], {
      defaultLimit: 20,
      maxLimit: 50
    });
  }
}

@Controller('feed')
export class FeedController {
  constructor(private readonly postRepo: PostRepository) {}

  // GET /feed?cursor=eyJ2IjoxLC...&limit=20
  @Get()
  async getFeed(
    @Query('cursor') cursor?: string,
    @Query('limit') limit = 20
  ) {
    const result = await this.postRepo.getAll({
      ...(cursor && { after: cursor }), // If cursor provided, use keyset mode
      sort: { publishedAt: -1 },
      limit: +limit
    });

    // Returns: { method: 'keyset', docs: [...], hasMore: true, next: 'cursor...' }
    return result;
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Post.name, schema: PostSchema }])
  ],
  controllers: [FeedController],
  providers: [PostRepository],
})
export class FeedModule {}
