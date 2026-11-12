SUBMIT = """    if (action === 'submitRegistration') {
      if (!eventId) return { success: false, message: 'Missing eventId' };
      const guestsRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestsRes.data || [])[0];
      return await switchFreeRegistration(cloud.database({ throwOnNotFound: false }), {
        openid, eventId, guest, validateTarget: freeEntryState,
        registrationData: {
          guestName: guest && (guest.nickName || guest.name) || '',
          guestAvatar: guest && guest.avatarUrl || '',
          guestPhone: guest && guest.phone || '',
          promoCode: guest && guest.promoCode || '',
          promoterId: guest && guest.promoterId || '',
          promoterName: guest && guest.promoterName || ''
        }
      });
    }

"""
COMPLETE = """    // Legacy promo-code entry uses exactly the same atomic free-entry policy.
    if (action === 'completeRegistration') {
      if (!promoCode || !eventId || !ticketType) {
        return { success: false, message: 'Missing required fields' };
      }
      const promoterCheck = await db.collection('promoters')
        .where({ promoCode: promoCode.toUpperCase().trim() }).get();
      const promoter = (promoterCheck.data || [])[0];
      if (!promoter || promoter.status === 'suspended' || promoter.status === 'revoked') {
        return { success: false, message: 'Invalid promo code' };
      }
      const guestsRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestsRes.data || [])[0];
      return await switchFreeRegistration(cloud.database({ throwOnNotFound: false }), {
        openid, eventId, guest, validateTarget: freeEntryState,
        registrationData: {
          guestName: guest && (guest.nickName || guest.name) || '',
          guestAvatar: guest && guest.avatarUrl || '',
          guestPhone: guest && guest.phone || '',
          promoCode: promoCode.toUpperCase().trim(),
          promoterId: promoter._id,
          promoterName: promoter.name
        }
      });
    }

"""

def client_transform(source):
    anchor="const { loadWechatConfig } = require('./wechatConfig');"
    if anchor not in source:
        # Older live bundles keep their configuration inline. Preserve it.
        anchor="const db = cloud.database();"
    assert source.count(anchor)==1
    source=source.replace(anchor,anchor+"\nconst { switchFreeRegistration } = require('./switchFreeRegistration');\nconst { retentionReason } = require('./freeRegistrationPolicy');")
    start=source.index("    if (action === 'submitRegistration') {")
    finish=source.index("    if (action === 'verifyPromoCode') {",start)
    source=source[:start]+SUBMIT+COMPLETE+source[finish:]
    anchor="  const toClear = marked.filter(r => windowsOverlap(thisWindow, eventWindowMs(eventDocs[r.eventId])));"
    assert source.count(anchor)==1
    source=source.replace(anchor,"  // Visits retained by the free-entry rule must survive a later venue scan.\n  const toClear = marked.filter(r => !retentionReason(r, eventDocs[r.eventId], Date.now()) &&\n    windowsOverlap(thisWindow, eventWindowMs(eventDocs[r.eventId])));")
    return source

def checkin_transform(source):
    anchor="const db = cloud.database();"
    assert source.count(anchor)==1
    source=source.replace(anchor,anchor+"\nconst { retentionReason } = require('./freeRegistrationPolicy');")
    # Exempt paid/protected tickets and genuinely retained free visits from
    # the old overlapping-venue cleanup. No payment records are rewritten.
    anchor="      const toClear = marked.filter(r => overlaps(thisWindow, eventWindowMs(eventDocs[r.eventId])));"
    assert source.count(anchor)==1
    source=source.replace(anchor,"      const toClear = marked.filter(r => !retentionReason(r, eventDocs[r.eventId], Date.now()) &&\n        overlaps(thisWindow, eventWindowMs(eventDocs[r.eventId])));")
    # A repeat staff tap must not restart a guest's three-hour attendance clock.
    source=source.replace("        arrivedAt,\n        checkedInAt: db.serverDate()","        arrivedAt: reg.arrivedAt || arrivedAt,\n        checkedInAt: reg.checkedInAt || db.serverDate()")
    return source


if __name__ == '__main__':
    import argparse
    import hashlib
    import json
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Patch a privately downloaded live bundle without changing its configuration')
    parser.add_argument('function', choices=['clientAuth', 'checkInGuest'])
    parser.add_argument('source_index')
    parser.add_argument('destination_index')
    args = parser.parse_args()
    original = Path(args.source_index).read_text()
    transform = client_transform if args.function == 'clientAuth' else checkin_transform
    patched = transform(original)
    target = Path(args.destination_index)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(patched)
    target.chmod(0o600)
    print(json.dumps({'function': args.function,
        'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
        'after_sha256': hashlib.sha256(patched.encode()).hexdigest()}))
