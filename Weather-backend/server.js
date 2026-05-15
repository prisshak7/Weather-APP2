const express = require('express')
const sqlite3 = require('sqlite3').verbose()
const cors = require('cors')
const path = require('path')
const { Parser } = require('json2csv')
const fetch = require('node-fetch')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const OWM_KEY = "c68cbb16ea96f5e1103aa4088ca1932a"

// setup sqlite database
const db = new sqlite3.Database('./weather.db', (err) => {
  if (err) console.log('db error', err)
  else console.log('connected to sqlite')
})

// create table if it doesnt exist
db.run(`CREATE TABLE IF NOT EXISTS weather_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  temp_min REAL,
  temp_max REAL,
  description TEXT,
  lat REAL,
  lon REAL,
  created_at TEXT DEFAULT (datetime('now'))
)`)

// CREATE - save a weather search
app.post('/api/weather', async (req, res) => {
  try {
    let { location, date_from, date_to } = req.body

    if (!location || !date_from || !date_to) {
      return res.status(400).json({ error: 'location, date_from, and date_to are required' })
    }

    let from = new Date(date_from)
    let to = new Date(date_to)
    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ error: 'invalid date format, use YYYY-MM-DD' })
    }
    if (to < from) {
      return res.status(400).json({ error: 'date_to must be after date_from' })
    }

    let geoRes = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${OWM_KEY}`)
    let geoData = await geoRes.json()
    if (!geoData || geoData.length === 0) {
      return res.status(404).json({ error: `location "${location}" not found` })
    }

    let { lat, lon, name, state, country } = geoData[0]
    let placeName = name + (state ? ', ' + state : '') + ', ' + country

    let wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_KEY}&units=imperial`)
    let wData = await wRes.json()

    let temp_min = wData.main.temp_min
    let temp_max = wData.main.temp_max
    let description = wData.weather[0].description

    db.run(
      `INSERT INTO weather_searches (location, date_from, date_to, temp_min, temp_max, description, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [placeName, date_from, date_to, temp_min, temp_max, description, lat, lon],
      function(err) {
        if (err) return res.status(500).json({ error: 'failed to save to database' })
        res.json({ id: this.lastID, location: placeName, date_from, date_to, temp_min, temp_max, description, lat, lon })
      }
    )
  } catch(e) {
    console.log('POST error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// READ - get all weather searches
app.get('/api/weather', (req, res) => {
  db.all(`SELECT * FROM weather_searches ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'failed to read from database' })
    res.json(rows)
  })
})

// READ - get single record
app.get('/api/weather/:id', (req, res) => {
  db.get(`SELECT * FROM weather_searches WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: 'failed to read record' })
    if (!row) return res.status(404).json({ error: 'record not found' })
    res.json(row)
  })
})

// UPDATE - update a record
app.put('/api/weather/:id', async (req, res) => {
  let { location, date_from, date_to } = req.body

  // validate dates if provided
  if (date_from && date_to) {
    let from = new Date(date_from)
    let to = new Date(date_to)
    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ error: 'invalid date format' })
    }
    if (to < from) {
      return res.status(400).json({ error: 'date_to must be after date_from' })
    }
  }

  // validate location if provided
  let lat, lon, placeName, temp_min, temp_max, description
  if (location) {
    let geoRes = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${OWM_KEY}`)
    let geoData = await geoRes.json()
    if (!geoData || geoData.length === 0) {
      return res.status(404).json({ error: `location "${location}" not found` })
    }
    lat = geoData[0].lat
    lon = geoData[0].lon
    placeName = geoData[0].name + (geoData[0].state ? ', ' + geoData[0].state : '') + ', ' + geoData[0].country

    let wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_KEY}&units=imperial`)
    let wData = await wRes.json()
    temp_min = wData.main.temp_min
    temp_max = wData.main.temp_max
    description = wData.weather[0].description
  }

  db.run(
    `UPDATE weather_searches SET
      location = COALESCE(?, location),
      date_from = COALESCE(?, date_from),
      date_to = COALESCE(?, date_to),
      temp_min = COALESCE(?, temp_min),
      temp_max = COALESCE(?, temp_max),
      description = COALESCE(?, description),
      lat = COALESCE(?, lat),
      lon = COALESCE(?, lon)
    WHERE id = ?`,
    [placeName, date_from, date_to, temp_min, temp_max, description, lat, lon, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'failed to update record' })
      if (this.changes === 0) return res.status(404).json({ error: 'record not found' })
      res.json({ message: 'updated successfully' })
    }
  )
})

// DELETE - delete a record
app.delete('/api/weather/:id', (req, res) => {
  db.run(`DELETE FROM weather_searches WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'failed to delete record' })
    if (this.changes === 0) return res.status(404).json({ error: 'record not found' })
    res.json({ message: 'deleted successfully' })
  })
})

// EXPORT - export all records as CSV
app.get('/api/export/csv', (req, res) => {
  db.all(`SELECT * FROM weather_searches`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'export failed' })
    const parser = new Parser()
    const csv = parser.parse(rows)
    res.header('Content-Type', 'text/csv')
    res.attachment('weather_data.csv')
    res.send(csv)
  })
})

// EXPORT - export as JSON
app.get('/api/export/json', (req, res) => {
  db.all(`SELECT * FROM weather_searches`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'export failed' })
    res.header('Content-Type', 'application/json')
    res.attachment('weather_data.json')
    res.send(JSON.stringify(rows, null, 2))
  })
})

// EXPORT - export as XML
app.get('/api/export/xml', (req, res) => {
  db.all(`SELECT * FROM weather_searches`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'export failed' })
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<weather_searches>\n'
    rows.forEach(row => {
      xml += '  <record>\n'
      Object.keys(row).forEach(key => {
        xml += `    <${key}>${row[key]}</${key}>\n`
      })
      xml += '  </record>\n'
    })
    xml += '</weather_searches>'
    res.header('Content-Type', 'application/xml')
    res.attachment('weather_data.xml')
    res.send(xml)
  })
})

app.listen(3000, () => console.log('server running on http://localhost:3000'))