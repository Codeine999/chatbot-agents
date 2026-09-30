export interface UploadedFile {
  fieldname: string;
  filename: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface MultipartPayload {
  fields: Map<string, string>;
  files: Map<string, UploadedFile>;
}

export interface ParseMultipartOptions {
  maxFileSize: number;
  maxFiles?: number;
  maxFields?: number;
  notMultipartMessage?: string;
  invalidMultipartMessage?: string;
}
