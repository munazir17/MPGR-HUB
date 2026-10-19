export const useRouter = () => ({ back: () => window.history.back(), replace: (path: string) => window.location.replace(path) });
