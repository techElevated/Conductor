/**
 * Conductor — Provider registry.
 *
 * Maintains a map of providerId → ProviderAdapter instances.
 * The extension registers adapters at activation time; the rest
 * of the codebase resolves adapters through this registry.
 */

import type { ProviderAdapter } from '../types';

const adapters = new Map<string, ProviderAdapter>();

/**
 * Register a provider adapter.  Throws if an adapter with the same
 * providerId is already registered.
 */
export function registerProvider(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.providerId)) {
    throw new Error(`Provider "${adapter.providerId}" is already registered`);
  }
  adapters.set(adapter.providerId, adapter);
}

/**
 * Unregister a provider by ID.  No-op if not found.
 */
export function unregisterProvider(providerId: string): void {
  adapters.delete(providerId);
}

/**
 * Retrieve a registered adapter by its providerId.
 * Returns undefined if no adapter is registered for the given ID.
 */
export function getProvider(providerId: string): ProviderAdapter | undefined {
  return adapters.get(providerId);
}

/**
 * Retrieve a registered adapter, throwing if not found.
 */
export function requireProvider(providerId: string): ProviderAdapter {
  const adapter = adapters.get(providerId);
  if (!adapter) {
    throw new Error(`Provider "${providerId}" is not registered`);
  }
  return adapter;
}

/**
 * List all registered provider IDs.
 */
export function getRegisteredProviders(): string[] {
  return [...adapters.keys()];
}

/**
 * List all registered adapters.
 */
export function getAllProviders(): ProviderAdapter[] {
  return [...adapters.values()];
}

/**
 * Clear all registered adapters.  Used in tests and on deactivation.
 */
export function clearProviders(): void {
  adapters.clear();
}
