import { SetMetadata } from '@nestjs/common';
import { PUBLIC_KEY } from './bearer-auth.guard';

// Opt a controller or route out of the global BearerAuthGuard.
export const Public = () => SetMetadata(PUBLIC_KEY, true);
