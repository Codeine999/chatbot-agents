import type { GatewayMetadata } from '@nestjs/websockets';

/** Shared by every gateway on the `admin` namespace: Nest builds the socket
 *  server from whichever gateway initialises first, so options must match. */
export const ADMIN_SOCKET_GATEWAY_OPTIONS: GatewayMetadata = {
  namespace: 'admin',
  cors: {
    origin: '*',
  },
};
