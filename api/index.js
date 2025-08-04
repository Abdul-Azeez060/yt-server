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
app.use(cors());

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
    const info = await ytdl.getInfo(videoURL);
    console.log("Video info retrieved:", info);
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, "");

    // Create previews directory if it doesn't exist
    const previewsDir = path.join(__dirname, "../previews");
    if (!fs.existsSync(previewsDir)) {
      fs.mkdirSync(previewsDir, { recursive: true });
    }

    // Set file paths
    const videoPath = path.join(previewsDir, `${title.slice(0, 25)}_video.mp4`);
    const audioPath = path.join(previewsDir, `${title.slice(0, 25)}_audio.mp4`);
    const fileName = `${title.slice(0, 25)}_${Date.now()}.mp4`;
    const songFileName = `${title.slice(0, 25)}_song.mp3`;

    // Download highest quality video (720p)
    const videoStream = ytdl(videoURL, {
      quality: "highestvideo",
      filter: (format) =>
        format.container === "mp4" &&
        (format.qualityLabel === "720p" || format.qualityLabel === "720p60"),
    });

    // Download highest quality audio
    const audioStream = ytdl(videoURL, {
      quality: "highestaudio",
      audioQuality: "AUDIO_QUALITY_HIGH",
    });

    console.log("Starting video and audio download...");

    // Download video and audio simultaneously
    const videoWriteStream = fs.createWriteStream(videoPath);
    const audioWriteStream = fs.createWriteStream(audioPath);

    videoStream.pipe(videoWriteStream);
    audioStream.pipe(audioWriteStream);

    let videoComplete = false;
    let audioComplete = false;

    // Check if both downloads are complete
    const checkCompletion = async () => {
      if (videoComplete && audioComplete) {
        console.log("Both video and audio downloaded, uploading to S3...");
        await uploadBothFiles();
      }
    };

    videoWriteStream.on("finish", () => {
      console.log("Video download completed");
      videoComplete = true;
      checkCompletion();
    });

    audioWriteStream.on("finish", () => {
      console.log("Audio download completed");
      audioComplete = true;
      checkCompletion();
    });

    // Upload both video and audio to S3
    const uploadBothFiles = async () => {
      try {
        // Read both files
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

        await Promise.all([
          s3Client.send(videoCommand),
          s3Client.send(audioCommand),
        ]);

        // Generate CDN URLs
        const videoCdnUrl = process.env.CLOUDFRONT_URL
          ? `${process.env.CLOUDFRONT_URL}/${fileName}`
          : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/video-previews/${fileName}`;

        const audioCdnUrl = process.env.CLOUDFRONT_URL
          ? `${process.env.CLOUDFRONT_URL}/audio/${songFileName}`
          : `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_DEFAULT_REGION}.amazonaws.com/audio/${songFileName}`;

        console.log("Upload successful - Video:", videoCdnUrl);
        console.log("Upload successful - Audio:", audioCdnUrl);

        // Delete local files
        fs.unlinkSync(videoPath);
        fs.unlinkSync(audioPath);

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
      } catch (uploadError) {
        console.error("Upload error:", uploadError);
        res.status(500).json({
          error: "Failed to upload to S3",
          details: uploadError,
        });
      }
    };

    // Handle download errors
    videoWriteStream.on("error", (error) => {
      console.error("Video download error:", error);
      res
        .status(500)
        .json({ error: "Failed to download video", details: error.message });
    });

    audioWriteStream.on("error", (error) => {
      console.error("Audio download error:", error);
      res
        .status(500)
        .json({ error: "Failed to download audio", details: error.message });
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "An error occurred while processing the request",
      details: error,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
