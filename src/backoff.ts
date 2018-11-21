export class RetryError extends Error {
  name: 'RetryError';
}

/**
 * Generator for an exponentially increasing value of power of two,
 * multiplied by a factor, up to a maximum value.
 * Optionally add a full random jitter to that number.
 *
 * @param base       base of the exponential value, usually 2 or 1 for fix intervals
 * @param factor     value by which to multiply the power of base
 * @param maxValue   ceiling to the exponential value (not including the jitter)
 * @param fullJitter If true, add a random number between [0, n] to value n.
 *
 * @returns an iterator over the values generated.
 */

export function* exponentialGenerator(
  base: number,
  factor: number,
  maxValue: number | undefined,
  minValue: number | undefined,
  fullJitter: boolean | undefined,
): IterableIterator<number> {
  let n = 0;
  // handle contradicting params
  if (minValue && maxValue && minValue > maxValue) {
    minValue = maxValue;
  }
  while (true) { // tslint:disable-line
    let value = factor * (base ** n);
    value = maxValue ? Math.min(maxValue, value) : value;
    value = minValue ? Math.max(minValue, value) : value;
    if (fullJitter) {
      value = Math.round(Math.random() * value);
    }
    yield value;
    n++;
  }
}

/**
 * Childish promise to sleep
 */
function sleep(ms: number): Promise<{}> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export type PredicateFunction = (result: any, context?: any[]) => boolean;

/**
 * The options to pass to retry
 *
 * @param maxRetries    passed this number, throw an Error
 * @param maxDelayMs    the maximum exponential delay (not including the jitter)
 * @param minDelayMs    the minimum exponential delay (not including the jitter)
 * @param base          base of the exponential value, usually 2 or 1 for fix intervals
 * @param backoffFactor the factor to the exponential values
 * @param predicate     a function that returns true when the call is to be retried
 * @param fullJitter    whether to add full random jitter to the exponential delays
 * @param sleepFunction optional function for delaying an action. Useful for testing.
 */
export interface BackoffOptions {
  maxRetries?: number;
  maxDelayMs?: number;
  minDelayMs?: number;
  base?: number;
  backoffFactor?: number;
  predicate?: PredicateFunction;
  fullJitter?: boolean;
  sleepFunction?: (ms: number) => Promise<any>;
}

/**
 * The main function here. It loops, calling the targetFunction, backing off
 * exponentially between each attempt.
 *
 * @param options         the options controlling the retries. @see BackoffOptions.
 * @param targetFunction  the function to call
 * @param thisArg         will bind the targetFunction to this
 * @param args            the arguments to pass to targetFunction
 */
export async function retry(
  options: BackoffOptions,
  targetFunction: any,
  thisArg: any = null,
  ...args: any[],
): Promise<any> {
  const {
    base = 2,
    maxRetries = 1,
    maxDelayMs,
    minDelayMs,
    backoffFactor = 50,
    predicate,
    fullJitter,
    sleepFunction = sleep,
  } = options;

  let numRetries = 1;
  let originalError;
  for (const delayMs of exponentialGenerator(base, backoffFactor, maxDelayMs, minDelayMs, fullJitter)) {
    try {
      const result = await targetFunction.apply(thisArg, args);
      if (thisArg && thisArg.emit) {
        thisArg.emit('retries', targetFunction.name, args, numRetries);
      }
      return result;
    } catch (err) {
      originalError = err;
      if (!predicate || !predicate(originalError, args)) {
        throw originalError;
      }
    }

    numRetries++;
    if (numRetries > maxRetries) {
      // The last error that was raised before the max retries is reached
      // will be the one thrown to the end-user, unless it's a "known" error
      // that was configured for backoff.
      if (!predicate || !predicate(originalError, args)) {
        throw originalError;
      } else {
        throw new RetryError(`Maximum of ${maxRetries} retries reached when calling target ${targetFunction.name}`);
      }
    }
    // sleep before retrying
    if (thisArg && thisArg.emit) {
      thisArg.emit('throttle', targetFunction.name, args, delayMs);
    }
    await sleepFunction(delayMs);
  }
}


/**
 * decorator taking the options as arguments
 */
export function backoffWith(backoffOptions: BackoffOptions): any {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const targetFunction = descriptor.value;
    // don't use => function here to keep access to 'this'
    const newFunction = async function(...args: any[]): Promise<any> {
      return await retry(backoffOptions, targetFunction, this, ...args);
    };

    descriptor.value = newFunction;
    return descriptor;
  };
}

/**
 * decorator taking the options from `this.backoffOptions`
 */
export function backoff(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  const targetFunction = descriptor.value;
  // don't use => function here to keep access to 'this'
  const newFunction = async function(...args: any[]): Promise<any> {
    return await retry(this.backoffOptions, targetFunction, this, ...args);
  };

  descriptor.value = newFunction;
  return descriptor;
}
