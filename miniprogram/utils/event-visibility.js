'use strict'

function isPaidEvent(event) {
  return !!event && (event.isPaid === true || event.hasPaidPackages === true)
}

function isPaidOnlyEvent(event) {
  return isPaidEvent(event) && event.hasFreeEntry === false
}

function splitVisibleEvents(events) {
  var list = Array.isArray(events) ? events : []
  var main = []
  var paidEvents = []

  list.forEach(function(event) {
    if (!event) return
    if (isPaidEvent(event)) paidEvents.push(event)
    if (!isPaidOnlyEvent(event) && event.eventsOnly !== true) main.push(event)
  })

  return { main: main, events: paidEvents }
}

module.exports = { isPaidEvent, isPaidOnlyEvent, splitVisibleEvents }
