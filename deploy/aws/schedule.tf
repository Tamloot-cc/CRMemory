# The consolidator: EventBridge runs one pass every consolidate_schedule.
# Each workspace is consolidated at most once per consolidate_interval_minutes.

resource "aws_cloudwatch_event_rule" "consolidate" {
  name                = "${var.name}-consolidate"
  description         = "Runs the Retainer consolidator over due workspaces"
  schedule_expression = var.consolidate_schedule
}

resource "aws_cloudwatch_event_target" "consolidate" {
  rule = aws_cloudwatch_event_rule.consolidate.name
  arn  = aws_lambda_function.this["consolidate"].arn

  # A run that finds the function stopped (during a deploy) is not retried:
  # the next scheduled run picks the workspaces up.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "consolidate_schedule" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["consolidate"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.consolidate.arn
}
