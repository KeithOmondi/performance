import { IUser } from '../modules/user/user.model';

declare module 'xss-clean' {
  import { RequestHandler } from 'express';
  const xss: () => RequestHandler;
  export default xss;
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      file?: Express.Multer.File;
      files?: Express.Multer.File[];
    }
  }
}