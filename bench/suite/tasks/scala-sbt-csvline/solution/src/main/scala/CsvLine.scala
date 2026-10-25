object CsvLine:
  def parse(line: String): Either[String, List[String]] =
    val fields = List.newBuilder[String]
    val field = new StringBuilder
    var i = 0
    var error: Option[String] = None
    var done = false
    while !done && error.isEmpty do
      if i < line.length && line(i) == '"' then
        i += 1
        var closed = false
        while !closed && error.isEmpty do
          if i >= line.length then error = Some(s"unclosed quote at column $i")
          else if line(i) == '"' && i + 1 < line.length && line(i + 1) == '"'
          then
            field.append('"'); i += 2
          else if line(i) == '"' then
            closed = true; i += 1
          else
            field.append(line(i)); i += 1
        if error.isEmpty && i < line.length && line(i) != ',' then
          error = Some(s"text after a closing quote at column $i")
      else
        while i < line.length && line(i) != ',' && error.isEmpty do
          if line(i) == '"' then
            error = Some(s"quote in an unquoted field at column $i")
          else
            field.append(line(i)); i += 1
      if error.isEmpty then
        fields += field.toString
        field.clear()
        if i < line.length then i += 1 else done = true
    error.toLeft(fields.result())
