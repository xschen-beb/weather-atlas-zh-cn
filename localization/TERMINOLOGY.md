# 中文术语与数据含义

| 原界面或变量 | 中文 | 说明 |
|---|---|---|
| Climate finder | 气候筛选 | 根据历史样本估计符合条件的日期和地区。 |
| Live weather | 实时天气 | 数值预报界面，不代表全图都是气象站实时观测。 |
| Apparent temperature / Feels like | 体感温度 | 综合温度、湿度和风的感受温度。 |
| Humidity（历史筛选 `dew`） | 露点温度 | 单位是温度，用于表示空气湿润程度。不能译为百分比相对湿度。 |
| Relative humidity（实时 `humidity`） | 相对湿度 | 单位为百分比。 |
| Sunshine duration | 日照时数 | 实际有直接日照的时长。 |
| Daylight duration | 昼长 | 日出至日落的时长，不等于日照时数。 |
| Precipitation（历史 `precip`） | 日降水量 | 雨和雪等降水的液态水当量。 |
| Precipitation rate（地图 `rate`） | 降水强度 | 单位是毫米/小时或英寸/小时。 |
| Snow depth | 积雪深度 | 地面已有积雪的厚度，不是新降雪量。 |
| Snowy（预设） | 有积雪 | 原预设筛选的是积雪深度。 |
| Clear days（云量≤25%） | 少云日数 | 避免让读者以为是无云日或气象站认定的晴天日数。 |
| Sea temperature / SST | 海表温度 | 附近海域的海表温度。 |
| Wind / gusts | 风速 / 阵风 | 持续风与短时阵风分别显示。 |
| Matching days / chance | 符合条件的天数 / 概率 | 从 365 个抽样日估计，日期概率包含前后 10 天平滑。 |

天气描述依据 Open-Meteo 的 WMO 天气代码区分毛毛雨、冻毛毛雨、冻雨、雪粒、阵雪及雷暴伴冰雹，避免照搬原站合并后的英文标签。

日期、月份、时间和界面单位采用中文。城市与国家/地区名称来自 Natural Earth 中文字段和 Unicode CLDR 地区名称；中文与英文名称均可用于搜索。

参考：

- https://open-meteo.com/en/docs （变量定义及 WMO 天气代码）
- https://github.com/nvkelso/natural-earth-vector （城市多语地名）
- https://github.com/BYVoid/OpenCC （繁体至简体字形转换）
