import { InternalServerErrorException } from '@nestjs/common';

export const getJson = async <T>(
  path: string,
  resource: string,
  accessToken: string,
  timeoutMs: number,
): Promise<T> => {
  const response = await fetch(`https://api.line.me${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`${resource} error:`, errorText);
    throw new InternalServerErrorException(`Failed to get ${resource}`);
  }

  return response.json() as Promise<T>;
};

