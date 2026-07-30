import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortTtlCache } from './requestCache'

describe('ShortTtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces two concurrent calls for the same key into one fetcher call', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn().mockResolvedValue('value')

    const [a, b] = await Promise.all([cache.get('k', fetcher), cache.get('k', fetcher)])

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(a).toBe('value')
    expect(b).toBe('value')
  })

  it('refetches once the TTL has elapsed', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn().mockResolvedValue('value')

    await cache.get('k', fetcher)
    vi.advanceTimersByTime(5001)
    await cache.get('k', fetcher)

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps separate keys independent', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn().mockResolvedValue('value')

    await Promise.all([cache.get('a', fetcher), cache.get('b', fetcher)])

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('evicts a rejected fetch immediately so the next call retries', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered')

    await expect(cache.get('k', fetcher)).rejects.toThrow('boom')
    await expect(cache.get('k', fetcher)).resolves.toBe('recovered')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('deleteMatching drops only keys with the given prefix', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn().mockResolvedValue('value')

    await cache.get('feed:a', fetcher)
    await cache.get('status', fetcher)
    cache.deleteMatching('feed:')

    await cache.get('feed:a', fetcher) // evicted -- refetches
    await cache.get('status', fetcher) // still cached -- no refetch

    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('clear drops every cached entry regardless of key', async () => {
    const cache = new ShortTtlCache(5000)
    const fetcher = vi.fn().mockResolvedValue('value')

    await cache.get('feed:a', fetcher)
    await cache.get('status', fetcher)
    cache.clear()

    await cache.get('feed:a', fetcher)
    await cache.get('status', fetcher)

    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})
