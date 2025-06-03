import { getCachedVideos, setCachedVideos, updateCacheAnalytics, warmCache, cleanupExpiredCache, getCacheStatistics } from './youTubeVideoCache'
import { db } from './db'

describe('youTubeVideoCache', () => {
  beforeEach(() => {
    spyOn(console, 'log')
    spyOn(console, 'error')
  })

  describe('getCachedVideos', () => {
    it('should return empty array when no video IDs provided', async () => {
      const result = await getCachedVideos([])
      expect(result).toEqual([])
    })

    it('should query database and return cached videos', async () => {
      const mockCachedVideos = [
        {
          video_id: 'video1',
          title: 'Test Video',
          channel_title: 'Test Channel',
          description: 'Test description',
          duration: 'PT3M30S',
          published_at: new Date('2023-01-01'),
          thumbnails: { default: { url: 'test.jpg' } },
          view_count: BigInt(1000),
          like_count: BigInt(100),
          tags: ['music', 'test'],
          source: 'youtube',
          cached_at: new Date(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          access_count: 1,
          last_accessed: new Date()
        }
      ]

      spyOn(db, 'selectFrom').and.returnValue({
        selectAll: () => ({
          where: () => ({
            where: () => ({
              execute: () => Promise.resolve(mockCachedVideos)
            })
          })
        })
      } as any)

      spyOn(db, 'updateTable').and.returnValue({
        set: () => ({
          where: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      const result = await getCachedVideos(['video1'])
      
      expect(result).toHaveLength(1)
      expect(result[0].videoId).toBe('video1')
      expect(result[0].title).toBe('Test Video')
    })

    it('should handle database errors gracefully', async () => {
      spyOn(db, 'selectFrom').and.throwError(new Error('Database error'))

      await expectAsync(getCachedVideos(['video1'])).toBeRejectedWithError('Failed to get cached videos: Database error')
    })
  })

  describe('setCachedVideos', () => {
    it('should skip when no video data provided', async () => {
      await setCachedVideos([])
      expect(console.log).toHaveBeenCalledWith('No video data provided, skipping cache set')
    })

    it('should cache videos with smart TTL', async () => {
      const videoData = [
        {
          videoId: 'video1',
          title: 'Test Video',
          channelTitle: 'Test Channel',
          description: 'Test description',
          duration: 'PT3M30S',
          publishedAt: new Date('2023-01-01'),
          thumbnails: { default: { url: 'test.jpg' } },
          viewCount: BigInt(1000),
          likeCount: BigInt(100),
          tags: ['music', 'test'],
          source: 'youtube'
        }
      ]

      spyOn(db, 'selectFrom').and.returnValue({
        selectAll: () => ({
          where: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      spyOn(db, 'insertInto').and.returnValue({
        values: () => ({
          onConflict: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      await setCachedVideos(videoData)
      expect(console.log).toHaveBeenCalledWith('Setting cached videos:', 1)
    })
  })

  describe('updateCacheAnalytics', () => {
    it('should create new analytics entry when none exists', async () => {
      spyOn(db, 'selectFrom').and.returnValue({
        selectAll: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve(null)
            })
          })
        })
      } as any)

      spyOn(db, 'insertInto').and.returnValue({
        values: () => ({
          execute: () => Promise.resolve([])
        })
      } as any)

      await updateCacheAnalytics('search', 'hit', 100, 50)
      expect(console.log).toHaveBeenCalledWith('Updating cache analytics: search - hit')
    })

    it('should update existing analytics entry', async () => {
      const existingAnalytics = {
        id: 1,
        endpoint: 'search',
        date: new Date(),
        total_requests: 10,
        cache_hits: 8,
        cache_misses: 2,
        quota_saved: 400,
        average_response_time_ms: 150
      }

      spyOn(db, 'selectFrom').and.returnValue({
        selectAll: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve(existingAnalytics)
            })
          })
        })
      } as any)

      spyOn(db, 'updateTable').and.returnValue({
        set: () => ({
          where: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      await updateCacheAnalytics('search', 'hit', 100, 50)
      expect(console.log).toHaveBeenCalledWith('Updated existing analytics entry for search')
    })
  })

  describe('cleanupExpiredCache', () => {
    it('should remove expired cache entries', async () => {
      const expiredEntries = [{ video_id: 'expired1' }, { video_id: 'expired2' }]

      spyOn(db, 'selectFrom').and.returnValue({
        select: () => ({
          where: () => ({
            execute: () => Promise.resolve(expiredEntries)
          })
        })
      } as any)

      spyOn(db, 'deleteFrom').and.returnValue({
        where: () => ({
          execute: () => Promise.resolve(expiredEntries)
        })
      } as any)

      await cleanupExpiredCache()
      expect(console.log).toHaveBeenCalledWith('Found 2 expired cache entries')
    })

    it('should handle no expired entries', async () => {
      spyOn(db, 'selectFrom').and.returnValue({
        select: () => ({
          where: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      await cleanupExpiredCache()
      expect(console.log).toHaveBeenCalledWith('No expired entries to clean up')
    })
  })

  describe('getCacheStatistics', () => {
    it('should return cache statistics', async () => {
      spyOn(db, 'selectFrom').and.returnValues(
        // Total cached videos
        {
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ count: 100 })
            })
          })
        } as any,
        // Expired videos
        {
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ count: 10 })
            })
          })
        } as any,
        // Today's analytics
        {
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({
                total_hits: 80,
                total_misses: 20,
                avg_response_time: 150,
                quota_saved: 500
              })
            })
          })
        } as any
      )

      const stats = await getCacheStatistics()
      
      expect(stats.totalCachedVideos).toBe(100)
      expect(stats.expiredVideos).toBe(10)
      expect(stats.hitRate).toBe(80) // 80% hit rate
      expect(stats.averageResponseTime).toBe(150)
      expect(stats.quotaSavedToday).toBe(500)
    })
  })
})