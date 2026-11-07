import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';

/** An API Gateway HTTP API (payload 2.0) event, as the $default route sends it. */
export function httpEvent(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): LambdaEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc123.execute-api.eu-central-1.amazonaws.com', ...options.headers },
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123',
      domainName: 'abc123.execute-api.eu-central-1.amazonaws.com',
      domainPrefix: 'abc123',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '192.0.2.1',
        userAgent: 'vitest',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '04/Nov/2026:10:00:00 +0000',
      timeEpoch: 1_793_786_400_000,
    },
    isBase64Encoded: false,
    ...(options.body === undefined ? {} : { body: options.body }),
  } as unknown as LambdaEvent;
}

export const context = {} as LambdaContext;

/** API Gateway decodes base64 bodies before the client sees them. */
export const bodyOf = (res: { body: string; isBase64Encoded: boolean }) =>
  res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString() : res.body;
