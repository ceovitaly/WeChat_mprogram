'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { makeEventsRenderSafe } = require('../miniprogram/utils/event-images.js')
const feedPath = path.join(__dirname, '../miniprogram/pages/feed/feed.js')

test('feed display copies never expose unresolved cloud image IDs', () => {
  const original = [{
    _id: 'event-1',
    coverImage: 'cloud://env/cover.jpg',
    promoImage: 'https://cdn.example.com/promo.jpg',
    promoImages: ['cloud://env/a.jpg', 'https://cdn.example.com/b.jpg'],
    promoMaterials: ['cloud://env/c.jpg']
  }]
  const safe = makeEventsRenderSafe(original)

  assert.equal(safe[0].coverImage, '')
  assert.equal(safe[0].promoImage, 'https://cdn.example.com/promo.jpg')
  assert.deepEqual(safe[0].promoImages, ['https://cdn.example.com/b.jpg'])
  assert.deepEqual(safe[0].promoMaterials, [])
  assert.equal(original[0].coverImage, 'cloud://env/cover.jpg')
  assert.equal(original[0].promoImages[0], 'cloud://env/a.jpg')
})

test('feed renders safe copies while resolving and caching original cloud IDs', () => {
  const feed = fs.readFileSync(feedPath, 'utf8')
  assert.match(feed, /var renderableEvents = makeEventsRenderSafe\(events\)/)
  assert.match(feed, /this\.setData\(\{ events: renderableEvents, loading: false, refreshing: false \}\)/)
  assert.match(feed, /this\.enrichEventImages\(events\)/)
  assert.match(feed, /var safeResolvedEvents = makeEventsRenderSafe\(resolvedEvents\)/)
  assert.match(feed, /wx\.setStorageSync\('events_cache', JSON\.stringify\(resolvedEvents\)\)/)
})
