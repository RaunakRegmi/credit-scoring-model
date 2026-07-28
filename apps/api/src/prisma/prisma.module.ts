import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global so services need not re-import it. The database is genuinely cross-cutting here;
 * scoping it per feature module would be ceremony without benefit.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
