import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { catalogRowsForUnownedEntries, DEFAULT_CONFIG, ensureInLibrary, parseAnimeIds } from '../server/app.js'

describe('SeaDex titles that are not in the library', () => {
  const candidate = (group: string, hash: string) => ({ releaseGroup: group, tracker: 'Nyaa', quality: '1080p', tags: [], dual_audio: false, size: 10, file_count: 12, info_hashes: [hash], is_best: true, source_files: [] })
  const entry = (group: string, hash: string, season = 1) => ({ url: 'https://releases.moe/x/', notes: 'n', seasons: { [season]: { candidates: [candidate(group, hash)] } } })

  test('parses TVDB ids, movie TMDB ids (a list) and the TVDB season from the mapping list', () => {
    const map = parseAnimeIds([
      { anilist_id: 1, type: 'TV', tvdb_id: 100, themoviedb_id: { tv: 5 }, season: { tvdb: 2, tmdb: 2 } },
      { anilist_id: 2, type: 'MOVIE', themoviedb_id: { movie: [128] } },
      { type: 'TV', tvdb_id: 9 },
    ])
    assert.deepEqual(map.get(1), { type: 'TV', tvdb: 100, tmdbMovie: null, tvdbSeason: 2 })
    assert.deepEqual(map.get(2), { type: 'MOVIE', tvdb: null, tmdbMovie: 128, tvdbSeason: null })
    assert.equal(map.size, 2)
  })

  test('lists only unowned titles it can add, sending movies to Radarr and TV to Sonarr', () => {
    const best = new Map<number, any>([
      [1, entry('GroupA', 'a'.repeat(40))],
      [2, entry('GroupB', 'b'.repeat(40), 0)],
      [3, entry('GroupC', 'c'.repeat(40))],
      [4, entry('GroupD', 'd'.repeat(40))],
      [5, entry('GroupE', 'e'.repeat(40))],
    ])
    const ids = new Map<number, any>([
      [1, { type: 'TV', tvdb: 100, tmdbMovie: null, tvdbSeason: 2 }],
      [2, { type: 'MOVIE', tvdb: null, tmdbMovie: 128, tvdbSeason: null }],
      [3, { type: 'TV', tvdb: 300, tmdbMovie: null, tvdbSeason: 1 }],
      [4, { type: 'TV', tvdb: 400, tmdbMovie: null, tvdbSeason: 1 }],
    ])
    const meta = new Map([[1, { title: 'Show One', cover: 'c.jpg', banner: null }]])
    const config = { ...DEFAULT_CONFIG, sonarr_url: 'http://s', sonarr_key: 'k', radarr_url: 'http://r', radarr_key: 'k' }
    // 3 is owned via AniList matching, 4 via its TVDB id, 5 has no id mapping.
    const { rows, noIds } = catalogRowsForUnownedEntries(config, best, new Set([3]), { tvdb: new Set([400]), tmdb: new Set() }, ids, meta)
    assert.equal(noIds, 1)
    assert.deepEqual(rows.map((row) => [row.arr, String(row.title).startsWith('AniList #') ? 'placeholder' : row.title, row.season, row.status]), [
      ['Sonarr', 'Show One', 2, 'new'],
      ['Radarr', 'placeholder', 0, 'new'],
    ])
    assert.equal(rows[0].tvdb_id, 100)
    assert.equal(rows[1].tmdb_id, 128)
    assert.equal(rows[0].releases[0].info_hashes[0], 'a'.repeat(40))
    assert.equal(rows[0].library_key, undefined, 'a title that is not in the library has no library key')
  })

  test('skips a title whose Sonarr/Radarr is not configured', () => {
    const best = new Map<number, any>([[2, entry('GroupB', 'b'.repeat(40), 0)]])
    const ids = new Map<number, any>([[2, { type: 'MOVIE', tvdb: null, tmdbMovie: 128, tvdbSeason: null }]])
    const { rows, noArr } = catalogRowsForUnownedEntries({ ...DEFAULT_CONFIG, sonarr_url: 'http://s', sonarr_key: 'k' }, best, new Set(), { tvdb: new Set(), tmdb: new Set() }, ids, new Map())
    assert.equal(rows.length, 0)
    assert.equal(noArr, 1)
  })

  test('adds a missing series to Sonarr with the usual root/profile and no automatic search', async () => {
    const originalFetch = globalThis.fetch
    let posted: any = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
      if (init?.method === 'POST' && url.includes('/series')) { posted = JSON.parse(String(init.body)); return json({ id: 1 }) }
      if (url.includes('/series?tvdbId=')) return json([])
      if (url.includes('/series/lookup')) return json([{ title: 'Looked Up', tvdbId: 100 }])
      if (url.includes('/rootfolder')) return json([{ path: '/media/tv' }, { path: '/media/other' }])
      if (url.includes('/qualityprofile')) return json([{ id: 1 }])
      if (url.includes('/series')) return json([{ path: '/media/tv/A', qualityProfileId: 7 }, { path: '/media/tv/B', qualityProfileId: 7 }, { path: '/media/other/C', qualityProfileId: 2 }])
      return json({})
    }) as typeof fetch
    try {
      const outcome = await ensureInLibrary({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr-add.test', sonarr_key: 'k' }, { status: 'new', arr: 'Sonarr', title: 'Show', tvdb_id: 100 })
      assert.equal(outcome, 'added')
      assert.equal(posted.title, 'Looked Up')
      assert.equal(posted.rootFolderPath, '/media/tv')
      assert.equal(posted.qualityProfileId, 7)
      assert.equal(posted.seriesType, 'anime')
      assert.equal(posted.addOptions.searchForMissingEpisodes, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not add a series or movie that already exists, and ignores titles that are in the library', async () => {
    const originalFetch = globalThis.fetch
    let posts = 0
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') posts += 1
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
    }) as typeof fetch
    try {
      const config = { ...DEFAULT_CONFIG, sonarr_url: 'http://s.test', sonarr_key: 'k', radarr_url: 'http://r.test', radarr_key: 'k' }
      assert.equal(await ensureInLibrary(config, { status: 'new', arr: 'Sonarr', title: 'A', tvdb_id: 1 }), 'existing')
      assert.equal(await ensureInLibrary(config, { status: 'new', arr: 'Radarr', title: 'B', tmdb_id: 2 }), 'existing')
      assert.equal(await ensureInLibrary(config, { status: 'upgrade', arr: 'Sonarr', title: 'C' }), 'not-needed')
      assert.equal(posts, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('adds a missing movie to Radarr without searching', async () => {
    const originalFetch = globalThis.fetch
    let posted: any = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return json({ id: 1 }) }
      if (url.includes('/movie?tmdbId=')) return json([])
      if (url.includes('/movie/lookup/tmdb')) return json({ title: 'Movie', tmdbId: 128 })
      if (url.includes('/rootfolder')) return json([{ path: '/media/movies' }])
      if (url.includes('/qualityprofile')) return json([{ id: 4 }])
      if (url.includes('/movie')) return json([])
      return json({})
    }) as typeof fetch
    try {
      assert.equal(await ensureInLibrary({ ...DEFAULT_CONFIG, radarr_url: 'http://radarr-add.test', radarr_key: 'k' }, { status: 'new', arr: 'Radarr', title: 'Movie', tmdb_id: 128 }), 'added')
      assert.equal(posted.rootFolderPath, '/media/movies')
      assert.equal(posted.qualityProfileId, 4)
      assert.equal(posted.addOptions.searchForMovie, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
