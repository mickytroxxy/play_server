// Import required modules
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fileUpload = require('express-fileupload');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();

// Define port
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

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

        // Return the fingerprint data to the client
        return res.json({
          success: true,
          message: 'Fingerprint generated successfully',
          data: fingerprintData
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

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
