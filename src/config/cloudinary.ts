import { v2 as cloudinary, UploadApiResponse, UploadApiOptions } from "cloudinary";
import { env } from "./env";
import { Readable } from "stream";
import pLimit from "p-limit"; 

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Limit concurrent uploads to 10 to manage network congestion
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
      // Removed async: true to ensure we get the secure_url back immediately
    };

    if (isVideo) {
      options.eager = [{ streaming_profile: "hd", quality: "auto" }];
      options.eager_async = true; // This is fine; it transcodes in BG but gives us the URL now
    } else if (isImage) {
      options.transformation = [{ width: 1600, crop: "limit", quality: "auto" }];
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Upload failed: No result from Cloudinary"));
        resolve(result);
      }
    );

    const stream = Readable.from(file.buffer);
    stream.pipe(uploadStream);
  });
};

export const uploadMultipleToCloudinary = async (
  files: Express.Multer.File[],
  folder: string
): Promise<UploadApiResponse[]> => {
  const uploadPromises = files.map((file) => 
    limit(() => uploadToCloudinary(file, folder))
  );
  
  return Promise.all(uploadPromises);
};

export { cloudinary };