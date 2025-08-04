const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const ffmpeg = require("fluent-ffmpeg");
const { Client, Databases, ID } = require("node-appwrite");
require("dotenv").config();

// Configure Appwrite client
const client = new Client();
client
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_KEY);

const databases = new Databases(client);

// Configure AWS S3 client
const s3Client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const app = express();
const PORT = 3000;

// Enable CORS for all routes
app.use(cors({ origin: "*" }));

// Basic route to test server
app.get("/", (req, res) => {
  res.send("YouTube Downloader is running.");
});

// Route to stream/download video
app.get("/download", async (req, res) => {
  const videoURL = req.query.url;
  const songId = req.query.song_id;

  if (!videoURL || !ytdl.validateURL(videoURL)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  if (!songId) {
    return res.status(400).json({ error: "Missing song_id parameter" });
  }

  console.log("Received URL:", videoURL);
  console.log("Song ID:", songId);

  try {
    // Set timeout for the entire operation (Vercel has 10-30s limits)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Operation timeout")), 25000); // 25 seconds
    });

    const downloadPromise = processDownload(videoURL, songId, res);

    await Promise.race([downloadPromise, timeoutPromise]);
  } catch (error) {
    console.error("Download error:", error);

    // More detailed error logging
    if (error.message === "Operation timeout") {
      return res.status(408).json({
        error: "Request timeout - video processing took too long",
        details: "Please try with a shorter video or try again later",
      });
    }

    return res.status(500).json({
      error: "An error occurred while processing the request",
      details: error.message || error,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Separate function to handle the download process
async function processDownload(videoURL, songId, res) {
  try {
    // Add options to bypass bot detection
    const info = await ytdl.getInfo(videoURL, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Cookie': 'CONSENT=YES+1'
        }
      }
    });
    
    console.log("Video info retrieved");
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, "");

    // Use /tmp directory for Vercel (serverless environments)
    const previewsDir = process.env.VERCEL
      ? "/tmp"
      : path.join(__dirname, "../previews");

    if (!process.env.VERCEL && !fs.existsSync(previewsDir)) {
      fs.mkdirSync(previewsDir, { recursive: true });
    }

    // Shorter filenames to avoid path length issues
    const timestamp = Date.now();
    const shortTitle = title.slice(0, 15).replace(/\s+/g, "_");
    const videoPath = path.join(previewsDir, `${shortTitle}_v_${timestamp}.mp4`);
    const audioPath = path.join(previewsDir, `${shortTitle}_a_${timestamp}.mp4`);
    const fileName = `${shortTitle}_${timestamp}.mp4`;
    const songFileName = `${shortTitle}_song_${timestamp}.mp3`;

    console.log("Starting download process...");

    // Use Promise-based approach with improved options
    const downloadVideo = new Promise((resolve, reject) => {
      const videoStream = ytdl(videoURL, {
        quality: "highestvideo",
        filter: (format) =>
          format.container === "mp4" &&
          (format.qualityLabel === "720p" || format.qualityLabel === "720p60"),
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Cookie': 'CONSENT=YES+1'
          }
        }
      });

      const videoWriteStream = fs.createWriteStream(videoPath);
      videoStream.pipe(videoWriteStream);

      videoWriteStream.on("finish", () => {
        console.log("Video download completed");
        resolve(videoPath);
      });

      videoWriteStream.on("error", reject);
      videoStream.on("error", reject);
    });

    const downloadAudio = new Promise((resolve, reject) => {
      const audioStream = ytdl(videoURL, {
        quality: "highestaudio",
        audioQuality: "AUDIO_QUALITY_HIGH",
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Cookie': 'CONSENT=YES+1'
          }
        }
      });

      const audioWriteStream = fs.createWriteStream(audioPath);
      audioStream.pipe(audioWriteStream);

      audioWriteStream.on("finish", () => {
        console.log("Audio download completed");
        resolve(audioPath);
      });

      audioWriteStream.on("error", reject);
      audioStream.on("error", reject);
    });

    // Wait for both downloads to complete
    await Promise.all([downloadVideo, downloadAudio]);

    console.log("Both downloads completed, uploading to S3...");

    // Upload files
    const videoBuffer = fs.readFileSync(videoPath);
    const audioBuffer = fs.readFileSync(audioPath);

    // Upload video to video-previews folder
    const videoUploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `video-previews/${fileName}`,
      Body: videoBuffer,
      ContentType: "video/mp4",
      ACL: "public-read",
    };

    // Upload audio to audio folder
    const audioUploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `video-previews/audio/${songFileName}`,
      Body: audioBuffer,
      ContentType: "audio/mp4",
      ACL: "public-read",
    };

    // Upload both files
    const videoCommand = new PutObjectCommand(videoUploadParams);
    const audioCommand = new PutObjectCommand(audioUploadParams);

    await Promise.all([s3Client.send(videoCommand), s3Client.send(audioCommand)]);

    // Generate CDN URLs
    const videoCdnUrl = process.env.CLOUDFRONT_URL
      ? `${process.env.CLOUDFRONT_URL}/${fileName}`
      : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/video-previews/${fileName}`;

    const audioCdnUrl = process.env.CLOUDFRONT_URL
      ? `${process.env.CLOUDFRONT_URL}/audio/${songFileName}`
      : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/audio/${songFileName}`;

    console.log("Upload successful - Video:", videoCdnUrl);
    console.log("Upload successful - Audio:", audioCdnUrl);

    // Clean up temporary files
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch (cleanupError) {
      console.warn("Cleanup error:", cleanupError);
    }

    // Save to Appwrite collection
    try {
      const document = await databases.createDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        ID.unique(),
        {
          song_id: songId,
          audio_url: audioCdnUrl,
          aws_url: videoCdnUrl,
        }
      );
      console.log("Data saved to Appwrite:", document.$id);
    } catch (appwriteError) {
      console.error("Appwrite save error:", appwriteError);
      // Continue with response even if Appwrite fails
    }

    // Return both URLs
    res.json({
      success: true,
      message: "Video and audio uploaded successfully",
      aws_url: videoCdnUrl,
      audio_url: audioCdnUrl,
      songId: songId,
    });

  } catch (processError) {
    console.error("Process download error:", processError);
    throw processError; // Re-throw to be handled by the main catch block
  }
}

  // Wait for both downloads to complete
  await Promise.all([downloadVideo, downloadAudio]);

  console.log("Both downloads completed, uploading to S3...");

  // Upload files
  const videoBuffer = fs.readFileSync(videoPath);
  const audioBuffer = fs.readFileSync(audioPath);

  // Upload video to video-previews folder
  const videoUploadParams = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `video-previews/${fileName}`,
    Body: videoBuffer,
    ContentType: "video/mp4",
    ACL: "public-read",
  };

  // Upload audio to audio folder
  const audioUploadParams = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `video-previews/audio/${songFileName}`,
    Body: audioBuffer,
    ContentType: "audio/mp4",
    ACL: "public-read",
  };

  // Upload both files
  const videoCommand = new PutObjectCommand(videoUploadParams);
  const audioCommand = new PutObjectCommand(audioUploadParams);

  await Promise.all([s3Client.send(videoCommand), s3Client.send(audioCommand)]);

  // Generate CDN URLs
  const videoCdnUrl = process.env.CLOUDFRONT_URL
    ? `${process.env.CLOUDFRONT_URL}/${fileName}`
    : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/video-previews/${fileName}`;

  const audioCdnUrl = process.env.CLOUDFRONT_URL
    ? `${process.env.CLOUDFRONT_URL}/audio/${songFileName}`
    : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/audio/${songFileName}`;

  console.log("Upload successful - Video:", videoCdnUrl);
  console.log("Upload successful - Audio:", audioCdnUrl);

  // Clean up temporary files
  try {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  } catch (cleanupError) {
    console.warn("Cleanup error:", cleanupError);
  }

  // Save to Appwrite collection
  try {
    const document = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID,
      ID.unique(),
      {
        song_id: songId,
        audio_url: audioCdnUrl,
        aws_url: videoCdnUrl,
      }
    );
    console.log("Data saved to Appwrite:", document.$id);
  } catch (appwriteError) {
    console.error("Appwrite save error:", appwriteError);
    // Continue with response even if Appwrite fails
  }

  // Return both URLs
  res.json({
    success: true,
    message: "Video and audio uploaded successfully",
    aws_url: videoCdnUrl,
    audio_url: audioCdnUrl,
    songId: songId,
  });

  } catch (processError) {
    console.error("Process download error:", processError);
    throw processError; // Re-throw to be handled by the main catch block
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
