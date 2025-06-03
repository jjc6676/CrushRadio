import { 
  getCachedSearchResults, 
  setCachedSearchResults, 
  updateSearchAnalytics, 
  normalizeSearchQuery, 
  calculateSearchTTL,
  getSearchCacheStatistics
} from './youTubeSearchCache'
import { db } from './db'
import { updateCacheAnalytics, setCachedVideos } from './youTubeVideoCache'

describe('youTubeSearchCache', () => {
  beforeEach(() => {
    spyOn(console, 'log')
    spyOn(console, 'error')
  })

  describe('normalizeSearchQuery', () => {
    it('should normalize query strings correctly', () => {
      expect(normalizeSearchQuery('Pop Music 2024!')).toBe('pop_music_2024')
      expect(normalizeSearchQuery('  Electronic   Dance  ')).toBe('electronic_dance')
      expect(normalizeSearchQuery('Rock & Roll')).toBe('rock__roll')
    })

    it('should include genre in normalized key', () => {
      expect(normalizeSearchQuery('best songs', 'pop')).toBe('pop_best_songs')
      expect(normalizeSearchQuery('classical music', 'classical')).toBe('classical_classical_music')
    })
  })

  describe('calculateSearchTTL', () => {
    it('should calculate TTL based on quality metrics', () => {
      const highQuality = {
        relevanceScore: 0.9,
        diversityScore: 0.8,
        freshnessScore: 0.7,
        popularityScore: 0.9
      }

      const ttl = calculateSearchTTL('popular music 2024', highQuality)
      expect(ttl).toBeGreaterThan(12) // Should be higher than base TTL
      expect(ttl).toBeLessThanOrEqualTo(72) // Should not exceed max
    })

    it('should consider query specificity', () => {
      const quality = {
        relevanceScore: 0.5,
        diversityScore: 0.5,
        freshnessScore: 0.5,
        popularityScore: 0.5
      }

      const shortQuery = calculateSearchTTL('music', quality)
      const longQuery = calculateSearchTTL('best electronic dance music 2024 hits', quality)
      
      expect(longQuery).toBeGreaterThan(shortQuery)
    })
  })

  describe('getCachedSearchResults', () => {
    it('should return null when no cached results found', async () => {
      spyOn(db, 'selectFrom').and.returnValue({
        selectAll: () => ({
          where: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  execute: () => Promise.resolve([])
                })
              })
            })
          })
        })
      } as any)

      spyOn(updateSearchAnalytics, 'bind').and.returnValue(() => Promise.resolve())

      const result = await getCachedSearchResults('test query')
      expect(result).toBeNull()
    })

    it('should return cached results when found', async () => {
      const mockCachedResults = [
        {
          video_id: 'video1',
          title: 'Test Song',
          channel_title: 'Test Artist',
          description: 'A test song',
          duration: 'PT3M30S',
          published_at: new Date('2023-01-01'),
          thumbnails: { default: { url: 'test.jpg' } },
          view_count: BigInt(1000),
          like_count: BigInt(100),
          tags: ['music', 'test'],
          source: 'search:test_query',
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
              orderBy: () => ({
                limit: () => ({
                  execute: () => Promise.resolve(mockCachedResults)
                })
              })
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

      const result = await getCachedSearchResults('test query')
      
      expect(result).toHaveLength(1)
      expect(result![0].videoId).toBe('video1')
      expect(result![0].title).toBe('Test Song')
    })
  })

  describe('setCachedSearchResults', () => {
    it('should skip when no results provided', async () => {
      await setCachedSearchResults('test query', 'pop', [])
      expect(console.log).toHaveBeenCalledWith('No search results provided, skipping cache set')
    })

    it('should cache search results with calculated TTL', async () => {
      const mockResults = [
        {
          videoId: 'video1',
          title: 'Test Song',
          channelTitle: 'Test Artist',
          description: 'A test song',
          duration: 'PT3M30S',
          publishedAt: new Date('2023-01-01'),
          thumbnails: { default: { url: 'test.jpg' } },
          viewCount: BigInt(1000),
          likeCount: BigInt(100),
          tags: ['music', 'test'],
          source: 'youtube'
        }
      ]

      spyOn(setCachedVideos)
      spyOn(db, 'updateTable').and.returnValue({
        set: () => ({
          where: () => ({
            execute: () => Promise.resolve([])
          })
        })
      } as any)

      await setCachedSearchResults('test query', 'pop', mockResults)
      
      expect(setCachedVideos).toHaveBeenCalledWith(mockResults)
      expect(console.log).toHaveBeenCalledWith('Setting cached search results for query:', 'test query', 'genre:', 'pop', 'results:', 1)
    })
  })

  describe('updateSearchAnalytics', () => {
    it('should update search analytics with proper endpoint', async () => {
      spyOn(updateCacheAnalytics)
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

      await updateSearchAnalytics('hit', {
        operation: 'hit',
        query: 'test',
        genre: 'pop',
        responseTimeMs: 100,
        quotaSaved: 50
      })

      expect(updateCacheAnalytics).toHaveBeenCalledWith('search:pop', 'hit', 100, 50)
    })
  })

  describe('getSearchCacheStatistics', () => {
    it('should return search cache statistics', async () => {
      const mockAnalytics = [
        {
          endpoint: 'search:pop',
          total_requests: 10,
          cache_hits: 8,
          cache_misses: 2,
          average_response_time_ms: 150,
          quota_saved: 400,
          date: new Date()
        }
      ]

      const mockTopSearches = [
        { source: 'search:pop_music', hits: 15 },
        { source: 'search:rock_songs', hits: 10 }
      ]

      spyOn(db, 'selectFrom').and.returnValues(
        // Analytics query
        {
          selectAll: () => ({
            where: () => ({
              where: () => ({
                execute: () => Promise.resolve(mockAnalytics)
              })
            })
          })
        } as any,
        // Top searches query
        {
          select: () => ({
            where: () => ({
              where: () => ({
                groupBy: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      execute: () => Promise.resolve(mockTopSearches)
                    })
                  })
                })
              })
            })
          })
        } as any
      )

      const stats = await getSearchCacheStatistics()
      
      expect(stats.totalSearchesCachedToday).toBe(10)
      expect(stats.searchHitRate).toBe(80) // 8/10 * 100
      expect(stats.averageSearchResponseTime).toBe(150)
      expect(stats.quotaSavedFromSearches).toBe(400)
      expect(stats.topSearchQueries).toHaveLength(2)
      expect(stats.topSearchQueries[0].query).toBe('pop music')
    })
  })
})