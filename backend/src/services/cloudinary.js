import { v2 as cloudinary } from "cloudinary";

export async function uploadBufferToCloudinary({ buffer, filename, mimetype }) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials are missing in environment variables");
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder: process.env.CLOUDINARY_FOLDER || "research-tool",
        public_id: `${Date.now()}-${sanitize(filename)}`,
        format: getExtensionFromName(filename),
        use_filename: false,
        filename_override: filename
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}

function sanitize(value) {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

function getExtensionFromName(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop()?.toLowerCase() : undefined;
}
