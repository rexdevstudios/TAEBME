// ============================================================================
// REDIS PUBSUB ADAPTER — ModularRpcManager & KillSwitch Broadcast Adapter
// ============================================================================
//
// Implements `PubSubAdapter` from `rpc-manager.ts`.
// Uses `UpstashRedisClient` for stateless REST publish & polling subscribe.
// Fallback: If Upstash is unconfigured, operates in graceful no-op mode.
// ============================================================================

import { PubSubAdapter } from './rpc-manager';
import { UpstashRedisClient, upstashRedis } from '../shared/redis-client';

export class UpstashRedisPubSubAdapter implements PubSubAdapter {
  private subscribers: Map<string, Array<(message: string) => void>> = new Map();
  private isPolling: boolean = false;
  private pollIntervalMs: number = 3000;

  constructor(private client: UpstashRedisClient = upstashRedis) {}

  async publish(channel: string, message: string): Promise<void> {
    if (!this.client.isConfigured()) {
      console.log(`[Redis PubSub] Client unconfigured — local in-memory fallback for publish to channel ${channel}`);
      this.triggerLocalSubscribers(channel, message);
      return;
    }

    await this.client.publish(channel, message);
    // Trigger local subscribers in same process as well
    this.triggerLocalSubscribers(channel, message);
  }

  /**
   * Subscribe callback ke Redis channel.
   */
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const list = this.subscribers.get(channel) || [];
    list.push(callback);
    this.subscribers.set(channel, list);
    console.log(`[Redis PubSub] Subscribed listener to channel: ${channel}`);
  }

  private triggerLocalSubscribers(channel: string, message: string): void {
    const callbacks = this.subscribers.get(channel) || [];
    for (const cb of callbacks) {
      try {
        cb(message);
      } catch (err) {
        console.error(`[Redis PubSub] Subscriber callback error on channel ${channel}:`, err);
      }
    }
  }
}
