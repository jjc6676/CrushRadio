import { sql } from 'kysely'
import { db } from './db'
import { getCachedVideos, setCachedVideos, updateCacheAnalytics } from './youTubeVideoCache'
import type { CachedVideoData, CacheOperation } from './youTubeVideoCache'

export type CachedSearchResult = {
  query: string
  genre: string | null
  maxResults: number
  videoIds: string[]
  totalResults: number
  searchedAt: Date
  expiresAt: Date
}

export type SearchResultQuality = {
  relevanceScore: number
  diversityScore: number
  freshnessScore: number
  popularityScore: number
}

export type SearchAnalyticsData = {
  operation: CacheOperation
  query: string
  genre?: string
  responseTimeMs?: number
  quotaSaved?: number
  resultCount?: number
}

/**
 * Get cached search results from database
 */
export async function getCachedSearchResults(
  query: string, 
  genre: string | null = null, 
  maxResults: number = 50
): Promise<CachedVideoData[] | null> {
  console.log('Getting cached search results for query:', query, 'genre:', genre, 'maxResults:', maxResults)
  
  try {
    const startTime = Date.now()
    const normalizedKey = normalizeSearchQuery(query, genre)
    
    // Check if we have cached search results
    const cachedSearch = await db
      .selectFrom('youtube_video_cache')
      .selectAll()
      .where('source', '=', `search:${normalizedKey}`)
      .where('expires_at', '>', new Date())
      .orderBy('cached_at', 'desc')
      .limit(maxResults)
      .execute()

    const responseTime = Date.now() - startTime
    
    if (cachedSearch.length === 0) {
      console.log('No cached search results found for query:', normalizedKey)
      await updateSearchAnalytics('miss', { operation: 'miss', query, genre: genre || undefined, responseTimeMs: responseTime })
      return null
    }

    console.log(`Found ${cachedSearch.length} cached search results for query: ${normalizedKey}`)

    // Update access counts
    const videoIds = cachedSearch.map(result => result.video_id)
    await db
      .updateTable('youtube_video_cache')
      .set({
        access_count: sql`coalesce(${sql.ref('access_count')}, 0) + 1`,
        last_accessed: new Date()
      })
      .where('video_id', 'in', videoIds)
      .execute()

    // Convert to CachedVideoData format
    const searchResults: CachedVideoData[] = cachedSearch.map(result => ({
      videoId: result.video_id,
      title: result.title,
      channelTitle: result.channel_title,
      description: result.description,
      duration: result.duration,
      publishedAt: result.published_at,
      thumbnails: result.thumbnails as Record<string, any>,
      viewCount: result.view_count,
      likeCount: result.like_count,
      tags: result.tags as string[] | null,
      source: result.source
    }))

    await updateSearchAnalytics('hit', { 
      operation: 'hit', 
      query, 
      genre: genre || undefined, 
      responseTimeMs: responseTime,
      resultCount: searchResults.length,
      quotaSaved: 100 // Estimate quota saved for search
    })

    return searchResults
  } catch (error) {
    console.error('Error getting cached search results:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to get cached search results: ${error.message}`)
    }
    throw new Error('Failed to get cached search results: Unknown error')
  }
}

/**
 * Store search results in cache with smart TTL
 */
export async function setCachedSearchResults(
  query: string,
  genre: string | null = null,
  results: CachedVideoData[]
): Promise<void> {
  console.log('Setting cached search results for query:', query, 'genre:', genre, 'results:', results.length)
  
  if (results.length === 0) {
    console.log('No search results provided, skipping cache set')
    return
  }

  try {
    const startTime = Date.now()
    const normalizedKey = normalizeSearchQuery(query, genre)
    
    // Calculate search result quality
    const resultQuality = calculateSearchResultQuality(results)
    console.log('Search result quality scores:', resultQuality)

    // Calculate smart TTL based on query and result quality
    const ttlHours = calculateSearchTTL(query, resultQuality)
    console.log(`Calculated TTL for search "${normalizedKey}": ${ttlHours} hours`)

    // First, cache the individual videos using the video cache
    await setCachedVideos(results)

    // Then update the source field to mark them as search results
    const videoIds = results.map(r => r.videoId)
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000)

    await db
      .updateTable('youtube_video_cache')
      .set({
        source: `search:${normalizedKey}`,
        expires_at: expiresAt,
        cached_at: new Date()
      })
      .where('video_id', 'in', videoIds)
      .execute()

    // Update search-specific popularity tracking
    await updateSearchPopularityTracking(query, genre, results, resultQuality)

    const responseTime = Date.now() - startTime
    console.log(`Cached search results for "${normalizedKey}" in ${responseTime}ms`)

    await updateSearchAnalytics('set', {
      operation: 'set',
      query,
      genre: genre || undefined,
      responseTimeMs: responseTime,
      resultCount: results.length,
      quotaSaved: results.length * 50 // Estimate quota saved
    })
  } catch (error) {
    console.error('Error setting cached search results:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to set cached search results: ${error.message}`)
    }
    throw new Error('Failed to set cached search results: Unknown error')
  }
}

/**
 * Update search-specific analytics
 */
export async function updateSearchAnalytics(
  operation: CacheOperation,
  metadata: SearchAnalyticsData
): Promise<void> {
  console.log('Updating search analytics:', operation, metadata)
  
  try {
    const endpoint = `search${metadata.genre ? `:${metadata.genre}` : ''}`
    
    // Use the existing cache analytics system but with search-specific endpoint
    await updateCacheAnalytics(
      endpoint,
      operation,
      metadata.responseTimeMs,
      metadata.quotaSaved
    )

    // Track search-specific metrics
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Update daily search analytics
    const existingSearchAnalytics = await db
      .selectFrom('youtube_cache_analytics')
      .selectAll()
      .where('endpoint', '=', `search_queries`)
      .where('date', '=', today)
      .executeTakeFirst()

    if (existingSearchAnalytics) {
      await db
        .updateTable('youtube_cache_analytics')
        .set({
          total_requests: (existingSearchAnalytics.total_requests || 0) + 1,
          cache_hits: operation === 'hit' ? (existingSearchAnalytics.cache_hits || 0) + 1 : existingSearchAnalytics.cache_hits,
          cache_misses: operation === 'miss' ? (existingSearchAnalytics.cache_misses || 0) + 1 : existingSearchAnalytics.cache_misses,
          quota_saved: (existingSearchAnalytics.quota_saved || 0) + (metadata.quotaSaved || 0)
        })
        .where('id', '=', existingSearchAnalytics.id)
        .execute()
    } else {
      await db
        .insertInto('youtube_cache_analytics')
        .values({
          endpoint: 'search_queries',
          date: today,
          total_requests: 1,
          cache_hits: operation === 'hit' ? 1 : 0,
          cache_misses: operation === 'miss' ? 1 : 0,
          quota_saved: metadata.quotaSaved || 0,
          average_response_time_ms: metadata.responseTimeMs || 0
        })
        .execute()
    }

    console.log(`Updated search analytics for operation: ${operation}`)
  } catch (error) {
    console.error('Error updating search analytics:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to update search analytics: ${error.message}`)
    }
    throw new Error('Failed to update search analytics: Unknown error')
  }
}

/**
 * Create normalized cache keys for search queries
 */
export function normalizeSearchQuery(query: string, genre: string | null = null): string {
  console.log('Normalizing search query:', query, 'genre:', genre)
  
  // Normalize the query string
  const normalizedQuery = query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .replace(/\s/g, '_') // Replace spaces with underscores

  // Include genre in the key if provided
  const genrePrefix = genre ? `${genre.toLowerCase()}_` : ''
  const normalizedKey = `${genrePrefix}${normalizedQuery}`

  console.log('Normalized search key:', normalizedKey)
  return normalizedKey
}

/**
 * Determine optimal cache duration for search results
 */
export function calculateSearchTTL(query: string, resultQuality: SearchResultQuality): number {
  console.log('Calculating search TTL for query:', query, 'quality:', resultQuality)
  
  // Base TTL factors
  const baseTtlHours = 12 // 12 hours base for search results
  const maxTtlHours = 72 // Maximum 3 days
  const minTtlHours = 2 // Minimum 2 hours

  // Quality score calculation (0-1)
  const overallQuality = (
    resultQuality.relevanceScore * 0.3 +
    resultQuality.diversityScore * 0.2 +
    resultQuality.freshnessScore * 0.25 +
    resultQuality.popularityScore * 0.25
  )

  // Query popularity factor (longer queries are more specific, cache longer)
  const queryWords = query.trim().split(/\s+/)
  const querySpecificityFactor = Math.min(2, 1 + queryWords.length * 0.1)

  // Calculate final TTL
  const qualityMultiplier = 1 + overallQuality * 1.5 // 1x to 2.5x multiplier
  const finalTtl = Math.round(baseTtlHours * qualityMultiplier * querySpecificityFactor)

  // Clamp to min/max bounds
  const clampedTtl = Math.max(minTtlHours, Math.min(maxTtlHours, finalTtl))

  console.log(`Search TTL calculation: base=${baseTtlHours}h, quality=${overallQuality.toFixed(3)}, specificity=${querySpecificityFactor.toFixed(2)}, final=${clampedTtl}h`)

  return clampedTtl
}

/**
 * Calculate search result quality metrics
 */
function calculateSearchResultQuality(results: CachedVideoData[]): SearchResultQuality {
  console.log('Calculating search result quality for', results.length, 'results')
  
  if (results.length === 0) {
    return {
      relevanceScore: 0,
      diversityScore: 0,
      freshnessScore: 0,
      popularityScore: 0
    }
  }

  // Relevance score based on video metadata completeness
  const relevanceScore = results.reduce((acc, result) => {
    let score = 0.5 // Base score
    if (result.title) score += 0.2
    if (result.description) score += 0.1
    if (result.tags && result.tags.length > 0) score += 0.1
    if (result.duration !== 'PT0S') score += 0.1
    return acc + Math.min(1, score)
  }, 0) / results.length

  // Diversity score based on channel variety
  const uniqueChannels = new Set(results.map(r => r.channelTitle))
  const diversityScore = Math.min(1, uniqueChannels.size / Math.max(1, results.length * 0.7))

  // Freshness score based on publish dates
  const now = Date.now()
  const freshnessScore = results.reduce((acc, result) => {
    const ageInDays = (now - result.publishedAt.getTime()) / (1000 * 60 * 60 * 24)
    const freshnessValue = Math.max(0, 1 - ageInDays / 365) // Linearly decrease over a year
    return acc + freshnessValue
  }, 0) / results.length

  // Popularity score based on view and like counts
  const popularityScore = results.reduce((acc, result) => {
    const views = Number(result.viewCount || 0)
    const likes = Number(result.likeCount || 0)
    
    // Logarithmic scaling for popularity metrics
    const viewScore = views > 0 ? Math.min(1, Math.log10(views) / 8) : 0
    const likeScore = likes > 0 ? Math.min(1, Math.log10(likes) / 6) : 0
    
    return acc + (viewScore + likeScore) / 2
  }, 0) / results.length

  const quality = {
    relevanceScore,
    diversityScore,
    freshnessScore,
    popularityScore
  }

  console.log('Search result quality metrics:', quality)
  return quality
}

/**
 * Update search-specific popularity tracking
 */
async function updateSearchPopularityTracking(
  query: string,
  genre: string | null,
  results: CachedVideoData[],
  resultQuality: SearchResultQuality
): Promise<void> {
  console.log('Updating search popularity tracking for query:', query)
  
  try {
    // Update individual video popularity with search context
    const videoIds = results.map(r => r.videoId)
    
    // Increment search count for these videos
    await db
      .updateTable('youtube_content_popularity')
      .set({
        search_count: sql`coalesce(${sql.ref('search_count')}, 0) + 1`
      })
      .where('video_id', 'in', videoIds)
      .execute()

    // Track query popularity (could be stored in a separate table in the future)
    // For now, we'll log the search pattern for analysis
    console.log(`Search pattern tracked: query="${query}", genre="${genre}", resultCount=${results.length}, quality=${JSON.stringify(resultQuality)}`)

  } catch (error) {
    console.error('Error updating search popularity tracking:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to update search popularity tracking: ${error.message}`)
    }
    throw new Error('Failed to update search popularity tracking: Unknown error')
  }
}

/**
 * Get search cache statistics for monitoring
 */
export async function getSearchCacheStatistics(): Promise<{
  totalSearchesCachedToday: number
  searchHitRate: number
  averageSearchResponseTime: number
  quotaSavedFromSearches: number
  topSearchQueries: Array<{ query: string; hits: number }>
}> {
  console.log('Getting search cache statistics')
  
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    // Get search-specific analytics
    const searchAnalytics = await db
      .selectFrom('youtube_cache_analytics')
      .selectAll()
      .where('endpoint', 'like', 'search%')
      .where('date', '=', today)
      .execute()

    const totalRequests = searchAnalytics.reduce((sum, a) => sum + (a.total_requests || 0), 0)
    const totalHits = searchAnalytics.reduce((sum, a) => sum + (a.cache_hits || 0), 0)
    const totalMisses = searchAnalytics.reduce((sum, a) => sum + (a.cache_misses || 0), 0)
    const avgResponseTime = searchAnalytics.reduce((sum, a) => sum + (a.average_response_time_ms || 0), 0) / Math.max(1, searchAnalytics.length)
    const quotaSaved = searchAnalytics.reduce((sum, a) => sum + (a.quota_saved || 0), 0)

    const hitRate = totalHits + totalMisses > 0 ? (totalHits / (totalHits + totalMisses)) * 100 : 0

    // Get top search patterns (simplified - would need dedicated table for full implementation)
    const topSearches = await db
      .selectFrom('youtube_video_cache')
      .select(['source', db.fn.count<number>('video_id').as('hits')])
      .where('source', 'like', 'search:%')
      .where('cached_at', '>=', today)
      .groupBy('source')
      .orderBy('hits', 'desc')
      .limit(10)
      .execute()

    const topSearchQueries = topSearches.map(search => ({
      query: search.source.replace('search:', '').replace(/_/g, ' '),
      hits: search.hits
    }))

    const stats = {
      totalSearchesCachedToday: totalRequests,
      searchHitRate: hitRate,
      averageSearchResponseTime: avgResponseTime,
      quotaSavedFromSearches: quotaSaved,
      topSearchQueries
    }

    console.log('Search cache statistics:', stats)
    return stats
  } catch (error) {
    console.error('Error getting search cache statistics:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to get search cache statistics: ${error.message}`)
    }
    throw new Error('Failed to get search cache statistics: Unknown error')
  }
}