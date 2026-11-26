'use strict'

var SINGLE_IMAGE_FIELDS = ['promoImage', 'coverImage']
var IMAGE_ARRAY_FIELDS = ['promoImages', 'promoMaterials', 'images']

function isCloudUrl(value) {
  return typeof value === 'string' && value.indexOf('cloud://') === 0
}

function makeEventRenderSafe(event) {
  if (!event || typeof event !== 'object') return event
  var safe = Object.assign({}, event)

  SINGLE_IMAGE_FIELDS.forEach(function(field) {
    if (isCloudUrl(safe[field])) safe[field] = ''
  })

  IMAGE_ARRAY_FIELDS.forEach(function(field) {
    if (!Array.isArray(safe[field])) return
    safe[field] = safe[field].filter(function(value) {
      return typeof value === 'string' && value.length > 0 && !isCloudUrl(value)
    })
  })

  return safe
}

function makeEventsRenderSafe(events) {
  return (Array.isArray(events) ? events : []).map(makeEventRenderSafe)
}

module.exports = { isCloudUrl, makeEventRenderSafe, makeEventsRenderSafe }
