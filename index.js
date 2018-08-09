const HAS_ENV = ['MAPBOX_TOKEN', 'STON_API_KEY', 'LOGIN_API_KEY'].every(env => {
  if(!process.env[env]) {
    console.error('Missing environment variable', env)
    return false
  }
  return true
})

if(!HAS_ENV) {
  return
}

const express = require('express')
const app = express()
const server = require('http').Server(app)
const io = require('socket.io')(server)
const MongoClient = require('mongodb').MongoClient
const fetch = require('node-fetch')
const geoClient = require('@mapbox/mapbox-sdk/services/geocoding')({ accessToken: process.env.MAPBOX_TOKEN })

const LOGIN_URL = 'https://login2.datasektionen.se'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/pax2'
const STON_URL = 'http://ston.local/'//'https://ston.datasektionen.se'

;(async function() {
  try {
    const client = await MongoClient.connect(MONGO_URL, { useNewUrlParser: true })

    const db = client.db('pax')
    const pax = db.collection('pax')
    const res = await fetch(`${STON_URL}/api/pax?api_key=${process.env.STON_API_KEY}`)
    const data = await res.json()

    var i = 9;
    for (const n0llan of data) {
      //https://github.com/mapbox/mapbox-sdk-js/blob/master/docs/services.md#forwardgeocode
      if (!n0llan.street) {
        continue;
      }
      if (i-- < 0) {
        return;
      }

      let moreinfo = false
      if (!n0llan.longitude || !n0llan.latitude) {
        moreinfo = true
        const { body } = await geoClient.forwardGeocode({
          query: n0llan.street,
          proximity: [ 59.348135, 18.071440 ],
          types: [ 'address' ]
        }).send()
        console.log(body.features)
      }

      pax.update(
        { id: n0llan.id },
        { $set: {
            name: n0llan.name,
            rawAddress: {
              street: n0llan.street,
              city: n0llan.city,
              zip: n0llan.zip
            },
            coordinates: {
              longitude: n0llan.longitude,
              latitude: n0llan.latitude
            },
            addresses: moreinfo ? body.features : undefined,
          }
        },
        { upsert: true }
      )

      console.log("updated n0llan ", n0llan.name)
    }

     client.close()
  } catch (err) {
    console.error(err)
  }
})()

app.use(/\/$/, (req, res, next) => {
  if(req.query.token) {
    fetch(`${LOGIN_URL}/verify/${req.query.token}.json?api_key=${process.env.LOGIN_API_KEY}`)
      .then(res => {
        if(res.status !== 200)
          throw new Error(res.status)
        return res.json()
      })
      .then(json => next())
      .catch(err => {
        console.log(err)
        res.redirect(`${LOGIN_URL}/login?callback=${req.protocol}://${req.headers.host}/?token=`)
      })
  } else {
    res.redirect(`${LOGIN_URL}/login?callback=${req.protocol}://${req.headers.host}/?token=`)
  }
})

app.use(express.static('public'))

io.use((socket, next) => {
  fetch(`${LOGIN_URL}/verify/${socket.handshake.query.token}.json?api_key=${process.env.LOGIN_API_KEY}`)
  .then(res => {
      if(res.status !== 200) throw new Error(res.status)
      return res.json()
    })
    .then(json => {
      socket.user = json
      next()
    })
    .catch(err => next(new Error('Not authenticated')))
})
  .on('connection', async (socket) => {
    socket.emit('userEmail', socket.user.emails)
    socket.emit('mapToken', process.env.MAPBOX_TOKEN)

    try {
      const client = await MongoClient.connect(MONGO_URL, { useNewUrlParser: true })

      const db = client.db('pax')
      const pax = db.collection('pax')

      pax.find().toArray((err, n0llan) => {
        socket.emit('n0llan', n0llan)
      })

      socket.on('fixa', async ({ id, ...rest }) => {
        await pax.update(
          { id },
          { $set: rest }
        )

        // broadcast an update
        io.emit('update', await pax.findOne({ id }))
      })

      socket.on('paxa', async ({ id }) => {
        const { paxad } = await pax.findOne({id})
        if(paxad) {
          socket.emit('ERROR', 'Redan paxad!')
          return
        }

        await pax.update(
          { id },
          { $set: { paxad: socket.user } }
        )

        io.emit('update', await pax.findOne({ id }))
      })

      socket.on('avpaxa', async ({ id }) => {
        await pax.update(
          { id },
          { $unset: { paxad: '' } }
        )

        io.emit('update', await pax.findOne({ id }))
      })

      socket.on('disconnect', () => client.close())
    } catch(err) {
      console.error(err)
      socket.emit('error', err)
    }
})


server.listen(process.env.PORT || 3000, () => {
  console.log('server is running at %s', server.address().port)
})
