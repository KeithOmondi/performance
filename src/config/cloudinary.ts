import { v2 as cloudinary, UploadApiResponse, UploadApiOptions } from "cloudinary";
import { env } from "./env";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export const uploadToCloudinary = (
  file: Express.Multer.File,
  folder: string,
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const isVideo = file.mimetype.startsWith("video");
    const isImage = file.mimetype.startsWith("image");
    const isPdf = file.mimetype === "application/pdf";

    const options: UploadApiOptions = {
      folder,
      resource_type: "auto",
    };

    if (isVideo) {
      options.transformation = [{ streaming_profile: "hd" }, { quality: "auto" }];
      options.eager_async = true;
    } else if (isImage) {
      options.transformation = [
        { width: 1200, crop: "limit", quality: "auto", fetch_format: "auto" },
      ];
    }
    // ✅ PDFs: no flags, no transformation — stored as-is, publicly fetchable

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Upload failed"));
        resolve(result);
      },
    );

    const stream = Readable.from(file.buffer);
    stream.pipe(uploadStream);
  });
};

export const uploadMultipleToCloudinary = async (
  files: Express.Multer.File[],
  folder: string
): Promise<UploadApiResponse[]> => {
  const uploadPromises = files.map((file) => uploadToCloudinary(file, folder));
  return Promise.all(uploadPromises);
};

export { cloudinary };
// ✅ Export the configured instance so the proxy controller can use it