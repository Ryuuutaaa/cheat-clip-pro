/**
 * Resilient API client for Cheat Clip Pro.
 * Handles automatic retry when backend server is starting up or reloading (503 / network refused).
 */

export interface ResilientFetchOptions extends RequestInit {
  maxRetries?: number;
  retryDelay?: number;
  silent?: boolean;
}

/**
 * Fetch wrapper with automatic retry on 502/503/504 or network connection errors.
 * Ideal for startup probes (/api/cookies, /api/hardware-accel, /api/models).
 */
export async function resilientFetch(
  input: RequestInfo | URL,
  options: ResilientFetchOptions = {}
): Promise<Response> {
  const {
    maxRetries = 4,
    retryDelay = 800,
    silent = false,
    ...fetchInit
  } = options;

  let lastError: any = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(input, fetchInit);

      // If backend is ready (status < 500 or not 502/503/504), return response
      if (response.status !== 503 && response.status !== 502 && response.status !== 504) {
        return response;
      }

      lastResponse = response;
      if (!silent) {
        console.warn(
          `[resilientFetch] Backend responded with HTTP ${response.status} for ${String(input)} (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${retryDelay * Math.pow(1.5, attempt)}ms...`
        );
      }
    } catch (err: any) {
      lastError = err;
      if (!silent) {
        console.warn(
          `[resilientFetch] Network error for ${String(input)} (attempt ${attempt + 1}/${maxRetries + 1}):`,
          err?.message || err
        );
      }
    }

    if (attempt < maxRetries) {
      const delay = Math.round(retryDelay * Math.pow(1.5, attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError || new Error(`Failed to fetch ${String(input)} after ${maxRetries + 1} attempts`);
}
