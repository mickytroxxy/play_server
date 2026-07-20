// Import required modules
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fileUpload = require('express-fileupload');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4, v4: randomUUID } = require('uuid');
const CryptoJS = require('crypto-js');
const { parseBuffer } = require('music-metadata');

// Load environment variables
dotenv.config();

// Initialize Firebase Client SDK
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage');

const firebaseConfig = {
  apiKey: "AIzaSyC_YPbgewHXM_GtGYyQTI8I4rFQCWOqtn8",
  authDomain: "municipality-b179d.firebaseapp.com",
  projectId: "municipality-b179d",
  storageBucket: "municipality-b179d.appspot.com",
  messagingSenderId: "952540645244",
  appId: "1:952540645244:web:129d4269d2e120d3b246f9",
};

const firebaseApp = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp);
const firebaseStorage = getStorage(firebaseApp);

// Initialize express app
const app = express();

// Define port
const PORT = process.env.PORT || 8080;

// Global in-memory cache for generated music pending user approval to save
const pendingSongs = new Map();

// Helper function to extract Chromaprint fingerprint using local fpcalc utility
const getFingerprint = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(`fpcalc -json "${filePath}"`, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  });
};

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploads directory statically for access to generated music
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
  createParentPath: true,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  },
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: './uploads/'
}));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Simple route for testing
app.get('/', (_req, res) => {
  res.json({ message: 'Welcome to the Audio Fingerprinting Server!' });
});

// API routes
app.get('/api/hello', (_req, res) => {
  res.json({ message: 'Hello, World!' });
});

// Audio fingerprinting endpoint
app.post('/api/fingerprint', async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const audioFile = req.files.audio;

    // Check if the file is an audio file
    const allowedMimeTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp3', 'audio/x-m4a'];
    if (!allowedMimeTypes.includes(audioFile.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Only audio files are allowed.' });
    }

    // Generate a unique filename
    const fileName = `${uuidv4()}${path.extname(audioFile.name)}`;
    const filePath = path.join(uploadsDir, fileName);

    // Move the file to the uploads directory
    await audioFile.mv(filePath);

    // Execute fpcalc to generate the fingerprint
    exec(`fpcalc -json "${filePath}"`, (error, stdout, stderr) => {
      // Clean up the temporary file
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Error deleting file: ${err}`);
      });

      if (error) {
        console.error(`Error executing fpcalc: ${error.message}`);

        // Run diagnostics to help troubleshoot the issue
        const diagnostics = {
          error: 'Failed to generate fingerprint',
          details: error.message,
          command: `fpcalc -json "${filePath}"`,
          errorCode: error.code,
          errorSignal: error.signal,
          path: filePath,
          os: process.platform,
          nodeVersion: process.version
        };

        // Try to get fpcalc version information
        try {
          const fpcalcVersionOutput = require('child_process').execSync('fpcalc -version').toString();
          diagnostics.fpcalcVersion = fpcalcVersionOutput.trim();
        } catch (versionError) {
          diagnostics.fpcalcVersionError = versionError.message;

          // Check if fpcalc is installed
          try {
            const fpcalcPath = require('child_process').execSync('which fpcalc').toString();
            diagnostics.fpcalcPath = fpcalcPath.trim();
          } catch (whichError) {
            diagnostics.fpcalcNotFound = true;
            diagnostics.error = 'Failed to generate fingerprint: fpcalc not found. Please make sure Chromaprint is installed.';
          }
        }

        console.error('Diagnostics:', JSON.stringify(diagnostics, null, 2));
        return res.status(500).json(diagnostics);
      }

      if (stderr) {
        console.error(`fpcalc stderr: ${stderr}`);
      }

      try {
        // Parse the JSON output from fpcalc
        const fingerprintData = JSON.parse(stdout);

        // Hash the fingerprint using CryptoJS
        const originalFingerprint = fingerprintData.fingerprint;

        // Create different hash formats
        const sha256Hash = CryptoJS.SHA256(originalFingerprint).toString();
        const md5Hash = CryptoJS.MD5(originalFingerprint).toString();

        // Create response object with hashed fingerprints
        const responseData = {
          ...fingerprintData,
          originalFingerprint: fingerprintData.fingerprint,
          fingerprint: sha256Hash, // Replace original with SHA-256 hash
          hashes: {
            sha256: sha256Hash,
            md5: md5Hash
          }
        };

        // Return the fingerprint data to the client
        return res.json({
          success: true,
          message: 'Fingerprint generated and hashed successfully',
          data: responseData
        });
      } catch (parseError) {
        console.error(`Error parsing fpcalc output: ${parseError.message}`);
        return res.status(500).json({ error: 'Failed to parse fingerprint data' });
      }
    });
  } catch (error) {
    console.error(`Server error: ${error.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
});
// Music generation endpoint
app.post('/api/generate-music', async (req, res) => {
  try {
    const sanitizedUser = req.body.user;
    if (!sanitizedUser || typeof sanitizedUser !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sanitizedUser)) {
      return res.status(400).json({
        error: 'Invalid or missing user parameter. Only alphanumeric characters, dashes, and underscores are allowed.'
      });
    }

    const prompt = req.body.prompt;
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({
        error: 'Invalid or missing prompt parameter.'
      });
    }

    const artistName = req.body.artistName ? req.body.artistName.trim() : '';
    const songTitle = req.body.songTitle ? req.body.songTitle.trim() : '';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is not configured on the server. Please verify your environment configuration.'
      });
    }

    console.log(`Sending music generation request for user "${sanitizedUser}" with prompt: "${prompt}"`);

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'lyria-3-pro-preview',
        input: prompt,
        response_format: {
          type: 'audio'
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google API error response (Status ${response.status}): ${errorText}`);
      return res.status(response.status).json({
        error: `Google API returned status ${response.status}`,
        details: errorText
      });
    }

    const responseJson = await response.json();
    let audioBase64 = null;
    let lyricsArray = [];

    if (responseJson.steps && Array.isArray(responseJson.steps)) {
      for (const step of responseJson.steps) {
        if (step.type === 'model_output' && step.content && Array.isArray(step.content)) {
          for (const contentBlock of step.content) {
            if (contentBlock.type === 'audio' && contentBlock.data) {
              audioBase64 = contentBlock.data;
            } else if (contentBlock.type === 'text' && contentBlock.text) {
              lyricsArray.push(contentBlock.text);
            }
          }
        }
      }
    }

    if (!audioBase64) {
      return res.status(502).json({
        error: 'No audio data returned from Google API response.',
        response: responseJson
      });
    }

    const lyrics = lyricsArray.join('\n\n').trim();
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const userMusicDir = path.join(__dirname, 'uploads', 'music', sanitizedUser);

    // Create target directory if it does not exist
    if (!fs.existsSync(userMusicDir)) {
      fs.mkdirSync(userMusicDir, { recursive: true });
    }

    const songId = uuidv4();
    const fileName = `tmp_${songId}.mp3`;
    const filePath = path.join(userMusicDir, fileName);

    fs.writeFileSync(filePath, audioBuffer);
    console.log(`Saved temporary generated music to: ${filePath}`);

    // Store in global pendingSongs Map
    pendingSongs.set(songId, {
      id: songId,
      user: sanitizedUser,
      artistName: artistName || 'Unknown Artist',
      songTitle: songTitle || 'Untitled Track',
      prompt: prompt,
      lyrics: lyrics,
      tempPath: filePath,
      relativePath: `uploads/music/${sanitizedUser}/${fileName}`,
      sizeBytes: audioBuffer.length
    });

    return res.json({
      success: true,
      message: 'Music generated successfully. Ready to listen and save.',
      data: {
        id: songId,
        artistName: artistName || 'Unknown Artist',
        songTitle: songTitle || 'Untitled Track',
        lyrics: lyrics,
        relativePath: `uploads/music/${sanitizedUser}/${fileName}`,
        sizeBytes: audioBuffer.length
      }
    });

  } catch (error) {
    console.error(`Music generation endpoint error: ${error.message}`);
    return res.status(500).json({ error: `Internal server error: ${error.message}` });
  }
});

// Save music endpoint
app.post('/api/save-music', async (req, res) => {
  try {
    const { id, location, ownerId: requestOwnerId } = req.body;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid song ID parameter.' });
    }

    const song = pendingSongs.get(id);
    if (!song) {
      return res.status(404).json({ error: 'Song not found or has expired.' });
    }

    console.log('====================================');
    console.log('SAVING SONG REQUESTED BY USER:');
    console.log(`ID:            ${song.id}`);
    console.log(`User:          ${song.user}`);
    console.log(`Artist Name:   ${song.artistName}`);
    console.log(`Song Title:    ${song.songTitle}`);
    console.log(`Prompt:        ${song.prompt}`);
    console.log(`Lyrics:        \n${song.lyrics}`);
    console.log(`Temp Path:     ${song.tempPath}`);
    console.log('====================================');

    // Verify temp file exists before proceeding
    if (!fs.existsSync(song.tempPath)) {
      return res.status(410).json({ error: 'Temporary audio file has already been deleted or does not exist.' });
    }

    // 1. Parse MP3 duration from buffer (no fingerprinting needed for AI-generated music)
    let trackDurationSeconds = 0;
    try {
      const audioBuffer = fs.readFileSync(song.tempPath);
      const metadata = await parseBuffer(audioBuffer, 'audio/mpeg');
      trackDurationSeconds = Math.round(metadata.format.duration || 0);
      console.log(`Parsed audio duration: ${trackDurationSeconds}s`);
    } catch (metaErr) {
      console.warn(`Could not parse audio duration: ${metaErr.message}`);
    }
    const fingerprintData = randomUUID();

    // 2. Generate final IDs and file names
    const musicId = `music_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const sanitizeFilename = (name) => {
      return name.replace(/[^a-zA-Z0-9\s._-]/g, '').trim();
    };
    const cleanArtist = sanitizeFilename(song.artistName) || 'Unknown Artist';
    const cleanTitle = sanitizeFilename(song.songTitle) || 'Untitled Track';
    const finalFileName = `${cleanArtist} - ${cleanTitle}.mp3`;

    // 3. Upload file to Firebase Storage
    const storagePath = `music/${song.user}/${musicId}_audio.mp3`;
    const storageRef = ref(firebaseStorage, storagePath);

    console.log(`Uploading file to Firebase Storage: ${storagePath}`);
    const audioBuffer = fs.readFileSync(song.tempPath);
    await uploadBytes(storageRef, audioBuffer, {
      contentType: 'audio/mpeg'
    });

    const audioUrl = await getDownloadURL(storageRef);
    console.log(`Uploaded to Storage. URL: ${audioUrl}`);

    // 4. Save metadata documents to Firestore
    const currentLoc = location || 'Unknown';
    // Use explicit ownerId (Firebase user UID) if provided, otherwise fall back to song.user
    const firestoreOwnerId = (requestOwnerId && typeof requestOwnerId === 'string' && requestOwnerId.trim())
      ? requestOwnerId.trim()
      : song.user;
    const musicData = {
      id: musicId,
      title: song.songTitle,
      artist: song.artistName,
      active: true,
      genres: "AI",
      albumArt: 'https://mrdocs.empiredigitals.org/playIcon.png',
      audioUrl: audioUrl,
      url: audioUrl,
      duration: trackDurationSeconds,
      ownerId: firestoreOwnerId,
      uploadDate: new Date().toISOString(),
      playCount: 0,
      fileName: finalFileName,
      currentBid: 0,
      fingerprint: fingerprintData,
      titleLowerCase: song.songTitle.toLowerCase(),
      artistLowerCase: song.artistName.toLowerCase(),
      albumLowerCase: '',
      location: currentLoc
    };

    console.log(`Writing documents to Firestore collection 'music' and 'tracks' for ID: ${musicId}`);
    
    // Save to Firestore collections in parallel
    const writeMusicPromise = setDoc(doc(firestoreDb, 'music', musicId), musicData);
    
    const trackData = {
      ...musicData,
      ownerId: '',
      freePlays: 0,
      premiumPlays: 0,
      creditPlays: 0,
      creditPlaysClaimed: 0
    };
    const writeTracksPromise = setDoc(doc(firestoreDb, 'tracks', musicId), trackData);

    await Promise.all([writeMusicPromise, writeTracksPromise]);
    console.log('Successfully saved documents to Firestore.');

    // 5. Clean up temporary local file & in-memory cache
    fs.unlink(song.tempPath, (err) => {
      if (err) console.error(`Error deleting local temp file: ${err.message}`);
    });
    pendingSongs.delete(id);

    return res.json({
      success: true,
      message: 'Song saved to Firebase successfully.',
      data: {
        id: musicId,
        fileName: finalFileName,
        audioUrl: audioUrl
      }
    });

  } catch (error) {
    console.error(`Save music endpoint error: ${error.message}`);
    return res.status(500).json({ error: `Internal server error: ${error.message}` });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
