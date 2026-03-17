declare module 'piexifjs' {
  const piexif: {
    ImageIFD: Record<string, number>;
    ExifIFD: Record<string, number>;
    load(data: string): Record<string, Record<number, unknown>>;
    dump(data: Record<string, Record<number, unknown>>): string;
    insert(exif: string, jpegData: string): string;
  };

  export default piexif;
}
