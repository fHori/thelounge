import dayjs from "dayjs";

export const localeFormat = "D MMMM YYYY, HH:mm:ss";

export default (time: Date | number) => dayjs(time).format(localeFormat);
