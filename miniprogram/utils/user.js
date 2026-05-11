const { db, getOpenid } = require('./cloud')
const { COLLECTIONS } = require('./constants')

// Загрузить профиль текущего юзера (guest или promoter)
async function loadProfile() {
  const openid = await getOpenid()
  const database = await db()

  const guestRes = await database
    .collection(COLLECTIONS.GUESTS)
    .where({ _openid: openid })
    .get()

  if (guestRes.data.length > 0) {
    const user = guestRes.data[0]
    // Проверяем промоутер ли он
    const promoRes = await database
      .collection(COLLECTIONS.PROMOTERS)
      .where({ _openid: openid, status: 'approved' })
      .get()
    const isPromoter = promoRes.data.length > 0
    const promoterData = isPromoter ? promoRes.data[0] : null
    return { ...user, isPromoter, promoterData }
  }

  return null
}

// Сохранить/обновить профиль
async function saveProfile(nickName, avatarUrl) {
  const openid = await getOpenid()
  const database = await db()

  const existing = await database
    .collection(COLLECTIONS.GUESTS)
    .where({ _openid: openid })
    .get()

  if (existing.data.length > 0) {
    await database
      .collection(COLLECTIONS.GUESTS)
      .doc(existing.data[0]._id)
      .update({ data: { nickName, avatarUrl, updatedAt: database.serverDate() } })
    return existing.data[0]._id
  } else {
    const res = await database
      .collection(COLLECTIONS.GUESTS)
      .add({ data: { nickName, avatarUrl, createdAt: database.serverDate() } })
    return res._id
  }
}

module.exports = { loadProfile, saveProfile }