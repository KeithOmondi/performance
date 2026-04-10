import { v2 as cloudinary, UploadApiResponse, UploadApiOptions } from "cloudinary";
import { env } from "./env";
import { Readable } from "stream";
import pLimit from "p-limit"; // Install this: npm install p-limit

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Limit concurrent uploads to 10 at a time to prevent socket hangs
const limit = pLimit(10);

export const uploadToCloudinary = (
  file: Express.Multer.File,
  folder: string
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const isVideo = file.mimetype.startsWith("video");
    const isImage = file.mimetype.startsWith("image");

    const options: UploadApiOptions = {
      folder,
      resource_type: "auto",
      // Optimization: use 'async' for heavy operations to return response immediately
      async: true, 
    };

    if (isVideo) {
      // Don't wait for transcoding! Move to eager_async.
      options.eager = [{ streaming_profile: "hd", quality: "auto" }];
      options.eager_async = true;
    } else if (isImage) {
      // Use light transformations only
      options.transformation = [{ width: 1600, crop: "limit", quality: "auto" }];
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Upload failed"));
        resolve(result);
      }
    );

    // Stream directly from buffer to Cloudinary
    const stream = Readable.from(file.buffer);
    stream.pipe(uploadStream);
  });
};

export const uploadMultipleToCloudinary = async (
  files: Express.Multer.File[],
  folder: string
): Promise<UploadApiResponse[]> => {
  // We use p-limit to process 50 files in chunks of 10
  // This prevents the 5-second timeout by managing network congestion
  const uploadPromises = files.map((file) => 
    limit(() => uploadToCloudinary(file, folder))
  );
  
  return Promise.all(uploadPromises);
};

export { cloudinary };