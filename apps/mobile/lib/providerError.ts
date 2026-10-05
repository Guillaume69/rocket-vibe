import type { ProviderError } from './provider.ts';
import { RestError, TwoFactorError, isTokenRejected } from './rest.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';

export function describeProviderError(error: unknown, authenticated: boolean): ProviderError {
  if (error instanceof NativeError) return {
    code:error.code, status:error.status, requestId:error.requestId ?? null,
    retryAfter:error.retryAfter ?? null,
    rejectsSession:authenticated && error.status === 401 && error.code === 'session_rejected',
    twoFactorChallenge:false,
  };
  if (error instanceof RestError) return {
    code:error.errorType ?? 'server_error', status:error.status, requestId:null,
    retryAfter:null, rejectsSession:authenticated && isTokenRejected(error),
    twoFactorChallenge:error instanceof TwoFactorError,
  };
  return {code:'connection_failed', status:0, requestId:null, retryAfter:null, rejectsSession:false, twoFactorChallenge:false};
}
